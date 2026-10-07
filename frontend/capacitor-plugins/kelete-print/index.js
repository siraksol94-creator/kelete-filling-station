// kelete-print has no JavaScript API of its own. Its Android code adds
// window.KeleteAndroid to every page the APK loads, and utils/printHtml.js
// calls that directly. This file exists so npm treats the folder as a normal
// package; the web bundle never imports it.
module.exports = {};
