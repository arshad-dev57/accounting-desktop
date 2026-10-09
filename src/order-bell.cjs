/**
 * Kitchen order alarm — loud alternating beeps for ~5s (macOS / Windows).
 */
const BELL_DURATION_MS = 5000;

const BELL_SCRIPT = `(function(){
  try {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    var ctx = new C();
    if (ctx.state === 'suspended') ctx.resume();

    var totalSec = 5.0;
    var beepSec = 0.48;
    var pauseSec = 0.04;
    var step = beepSec + pauseSec;
    var beeps = Math.floor(totalSec / step);
    var freqs = [880, 1175];

    function alarmBeep(at, freq) {
      var t = ctx.currentTime + at;
      var end = t + beepSec;

      var oscA = ctx.createOscillator();
      var oscB = ctx.createOscillator();
      var gain = ctx.createGain();

      oscA.type = 'square';
      oscB.type = 'square';
      oscA.frequency.setValueAtTime(freq, t);
      oscB.frequency.setValueAtTime(freq * 1.002, t);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.38, t + 0.025);
      gain.gain.setValueAtTime(0.38, t + beepSec * 0.55);
      gain.gain.linearRampToValueAtTime(0.0001, end);

      oscA.connect(gain);
      oscB.connect(gain);
      gain.connect(ctx.destination);
      oscA.start(t);
      oscB.start(t);
      oscA.stop(end);
      oscB.stop(end);

      var ping = ctx.createOscillator();
      var pingGain = ctx.createGain();
      ping.type = 'sine';
      ping.frequency.setValueAtTime(freq * 2.5, t);
      pingGain.gain.setValueAtTime(0.0001, t);
      pingGain.gain.linearRampToValueAtTime(0.14, t + 0.01);
      pingGain.gain.linearRampToValueAtTime(0.0001, t + 0.18);
      ping.connect(pingGain);
      pingGain.connect(ctx.destination);
      ping.start(t);
      ping.stop(t + 0.2);
    }

    for (var i = 0; i < beeps; i++) {
      alarmBeep(i * step, freqs[i % 2]);
    }

    setTimeout(function(){ ctx.close(); }, ${BELL_DURATION_MS});
  } catch (e) { /* ignore */ }
})()`;

function playOrderBell(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.executeJavaScript(BELL_SCRIPT, true).catch(() => {});
}

module.exports = { playOrderBell, BELL_DURATION_MS };
