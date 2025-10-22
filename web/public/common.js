function randomRoom() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function qs(sel){ return document.querySelector(sel); }
function getRoomFromQuery() {
  const params = new URLSearchParams(location.search);
  return params.get('room');
}
