// UX-4 — towns for the station-location picker (approximate town-centre
// coordinates; plenty for a weather forecast). Anything else: type coordinates.
const ZAMBIA_TOWNS = [
  ['Lusaka', -15.4167, 28.2833], ['Ndola', -12.9587, 28.6366], ['Kitwe', -12.8024, 28.2132], ['Livingstone', -17.8419, 25.8544],
  ['Kabwe', -14.4469, 28.4464], ['Chingola', -12.5289, 27.8536], ['Mufulira', -12.5497, 28.2406], ['Luanshya', -13.1367, 28.4166],
  ['Kalulushi', -12.8395, 28.0948], ['Chipata', -13.6333, 32.6500], ['Petauke', -14.2426, 31.3253], ['Solwezi', -12.1833, 26.4000],
  ['Kasama', -10.2129, 31.1808], ['Mpika', -11.8343, 31.4529], ['Nakonde', -9.3270, 32.7470], ['Mansa', -11.1990, 28.8943],
  ['Mongu', -15.2484, 23.1274], ['Choma', -16.8065, 26.9530], ['Monze', -16.2803, 27.4733], ['Mazabuka', -15.8560, 27.7480],
  ['Kafue', -15.7692, 28.1814], ['Chirundu', -16.0333, 28.8500], ['Siavonga', -16.5380, 28.7087], ['Kapiri Mposhi', -13.9711, 28.6818],
  ['Serenje', -13.2325, 30.2352], ['Chinsali', -10.5514, 32.0811], ['Kalomo', -17.0333, 26.4833], ['Sesheke', -17.4760, 24.2970],
].map(([name, lat, lon]) => ({ name, lat, lon }));

export default ZAMBIA_TOWNS;
