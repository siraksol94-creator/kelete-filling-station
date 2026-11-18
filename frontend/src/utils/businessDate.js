// The station's business date (Zambia, UTC+2, no daylight saving).
// new Date().toISOString().slice(0, 10) gives the UTC date, which is still
// "yesterday" between 00:00 and 02:00 in Lusaka. A fixed offset (not the
// browser's own time zone) so an HQ user abroad sees the same trading day.
// Keep in step with backend/config/businessTime.js.
export const BUSINESS_UTC_OFFSET_MINUTES = 120;

export const businessToday = (at = new Date()) =>
  new Date(at.getTime() + BUSINESS_UTC_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
