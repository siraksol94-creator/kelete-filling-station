// ESC/POS printer dispatcher. Two transports:
//   USB â†’ writes the raw ticket to the Windows Print Spooler queue (`receipt_printer_name`)
//         using the same PowerShell + winspool.Drv trick the existing /open-drawer route uses.
//   LAN â†’ opens a TCP socket to `receipt_printer_ip:receipt_printer_port` (default 9100).
//
// Falls back silently â€” printer issues must never break the order/payment flow.
const net  = require('net');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { exec } = require('child_process');

const ESC = '\x1B';
const GS  = '\x1D';

const CMD = {
  INIT:         ESC + '@',
  ALIGN_LEFT:   ESC + '\x61\x00',
  ALIGN_CENTER: ESC + '\x61\x01',
  ALIGN_RIGHT:  ESC + '\x61\x02',
  BOLD_ON:      ESC + '\x45\x01',
  BOLD_OFF:     ESC + '\x45\x00',
  DBL_HEIGHT:   ESC + '\x21\x10',
  DBL_BOTH:     ESC + '\x21\x30',
  NORMAL:       ESC + '\x21\x00',
  CUT:          GS  + 'V\x41\x05',
  FEED:         ESC + 'd\x03',
  DRAWER_KICK:  ESC + 'p\x00\x19\xFA',
  // v1.10.62 â€” GS L nL nH sets left margin in dots (nH*256+nL). Epson
  // TM-T88VII prints at 180dpi, so 24 dots â‰ˆ 3.4mm. Compensates for the
  // physical paper feed offset that clips leftmost characters.
  LEFT_MARGIN_24: GS + 'L\x18\x00',
};

// â”€â”€ Settings helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns { type, name, ip, port } from business_settings, with sane defaults.
// Falls back to the legacy sync_config.drawer_port for the USB name when
// receipt_printer_name isn't set yet â€” so existing tenants keep working.
function loadPrinterSettings(db) {
  let row;
  try { row = db.prepare('SELECT receipt_printer_type, receipt_printer_name, receipt_printer_ip, receipt_printer_port FROM business_settings LIMIT 1').get(); }
  catch { row = null; }
  let legacyName = null;
  try { legacyName = db.prepare("SELECT value FROM sync_config WHERE key = 'drawer_port'").get()?.value || null; }
  catch { /* ignore */ }
  return {
    type: (row?.receipt_printer_type || 'usb').toLowerCase(),
    name: row?.receipt_printer_name || legacyName || 'POS-80',
    ip:   row?.receipt_printer_ip || '',
    port: parseInt(row?.receipt_printer_port) || 9100,
  };
}

// â”€â”€ LAN print â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Opens a TCP socket, writes the raw bytes, closes. Resolves silently on error.
function printOverLAN(ip, port, bytes) {
  return new Promise((resolve) => {
    if (!ip) { resolve({ ok: false, error: 'No LAN IP configured' }); return; }
    const client = new net.Socket();
    const timeout = setTimeout(() => { client.destroy(); resolve({ ok: false, error: 'LAN printer timeout' }); }, 5000);
    let done = false;
    const finish = (result) => { if (done) return; done = true; clearTimeout(timeout); try { client.destroy(); } catch {} resolve(result); };
    client.connect(parseInt(port) || 9100, ip, () => {
      client.write(Buffer.from(bytes, 'binary'), () => {
        // Small grace period for the printer to drain before we destroy the socket.
        setTimeout(() => finish({ ok: true }), 500);
      });
    });
    client.on('error', (e) => finish({ ok: false, error: e.message }));
  });
}

// â”€â”€ USB print (Windows Print Spooler) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses the same RAW winspool.Drv approach as /open-drawer â€” sends bytes directly
// to the configured printer queue with no driver interpretation. Resolves with
// `{ ok, error? }` so callers can surface a problem if they care.
function printOverUSB(printerName, bytes) {
  return new Promise((resolve) => {
    if (!printerName) { resolve({ ok: false, error: 'No USB printer name configured' }); return; }
    const bytesCsv = Array.from(Buffer.from(bytes, 'binary')).join(',');
    const psScript = `
$source = @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter")] public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter")] public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter")] public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter")] public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
    public static bool Send(string printer, byte[] bytes) {
        IntPtr hPrinter; IntPtr pBuf = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA(); di.pDocName = "kelete-receipt"; di.pDataType = "RAW";
        if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero)) return false;
        if (!StartDocPrinter(hPrinter, 1, di)) { ClosePrinter(hPrinter); return false; }
        StartPagePrinter(hPrinter);
        pBuf = System.Runtime.InteropServices.Marshal.AllocCoTaskMem(bytes.Length);
        System.Runtime.InteropServices.Marshal.Copy(bytes, 0, pBuf, bytes.Length);
        int written;
        WritePrinter(hPrinter, pBuf, bytes.Length, out written);
        System.Runtime.InteropServices.Marshal.FreeCoTaskMem(pBuf);
        EndPagePrinter(hPrinter); EndDocPrinter(hPrinter); ClosePrinter(hPrinter);
        return true;
    }
}
"@
Add-Type -TypeDefinition $source -Language CSharp
[RawPrint]::Send("${printerName.replace(/"/g, '\\"')}", [byte[]](${bytesCsv}))
`;
    const tmpPs = path.join(os.tmpdir(), `kelete_print_${Date.now()}.ps1`);
    try { fs.writeFileSync(tmpPs, psScript, 'utf8'); }
    catch (e) { resolve({ ok: false, error: e.message }); return; }
    exec(`powershell -ExecutionPolicy Bypass -File "${tmpPs}"`, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpPs); } catch {}
      if (err) resolve({ ok: false, error: stderr || err.message });
      else     resolve({ ok: true });
    });
  });
}

// â”€â”€ Public dispatcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Reads the configured transport from settings and routes accordingly.
// `bytes` is a string of raw ESC/POS data (use the CMD constants to compose it).
function sendToPrinter(db, bytes) {
  const s = loadPrinterSettings(db);
  if (s.type === 'lan') return printOverLAN(s.ip, s.port, bytes);
  return printOverUSB(s.name, bytes);
}

module.exports = { CMD, sendToPrinter, loadPrinterSettings, printOverLAN, printOverUSB };
