# Separate Vocal and MR Tracks

The desktop controller decodes both stems locally. Two AudioBufferSourceNodes
start at the same AudioContext time and offset. Pause stops both; seek rebuilds
both at the requested offset. The longer track defines the playback duration.
Changing volume or muting a stem does not change lyric analysis or timing.

Only the `vocal` multipart field is sent to `/api/model-align`. The server rejects
requests containing MR or the former mixed-audio field. The existing local Turbo
engine receives the untrimmed vocal file, preserving its original time origin.
No new model download is required. The acoustic alignment engine is unchanged
from the previously released version.

Stems must come from the same arrangement and retain the same starting silence.
Duration differences are flagged, but equal durations do not prove alignment.
There is no automatic alignment of stems from different recordings.

Unknown humming and effects still depend on the existing transcript matcher.
The app no longer fabricates a waveform-only timeline after model failure. This
change does not establish a measured improvement in song recognition accuracy.

The launcher opens one embedded WebView2 controller, not an external browser or
an OBS process. A Windows job owns the server and embedded browser. Normal close
requests server cleanup before closing the job; process termination also closes
the job. Each launch uses a fresh WebView profile. Normal shutdown removes it,
and the next launch removes crash leftovers. Installed models are preserved.

## Validation

- `node --test tests/stem-player.test.js tests/server-stems.test.js`: shared start,
  seek after 60 seconds, pause, shorter-stem ending, restart, volume, dispose,
  cancellation during audio resume, vocal-only upload, style state, and stopping
  an in-progress model-status subprocess on shutdown.
- `node tests/stems-browser.cjs` (Playwright required): generated WAV stems and a
  mocked recognition result exercise the real controller, server and overlay.
  Desktop/mobile screenshots, seek/pause/restart, animation on/off, analysis
  failure and closing the controller are checked. This is not an acoustic test.
- `tests/desktop-lifecycle.ps1 -ExistingProcessId <pid>` closes an already running
  local test EXE and checks all descendant processes. `-Crash` tests termination.
- Windows x64 self-contained launcher builds successfully. Real EXE testing
  confirmed the embedded controller and installed faster-whisper model status,
  empty inputs after restart, and no owned process remaining after normal close
  or forced termination.

This workflow is distributed through the existing `v0.1.0-alpha` release. The
installer fetches the updated application core and the bundled local runtimes.
