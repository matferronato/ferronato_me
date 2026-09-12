# BusScope — bus protocol timing

Cycle-accurate timing figures for ten interconnect protocols, drawn the way a
specification draws them: colour encodes which side drives the wire, and every
transfer is marked at the clock edge that captures it.

APB, AHB-Lite, AXI4, AXI4-Lite, AXI4-Stream, Avalon-MM, Avalon-ST, Wishbone,
I2C, SPI.

## Run

```bash
python3 server.py            # http://127.0.0.1:8782
python3 server.py --open     # and open a browser
python3 server.py --port 9000
```

Standard library only. No JavaScript build step, no dependencies, no CDN.

## Test

```bash
node tests.mjs
```

97 checks across 120 generated configurations: APB phase structure, AHB address
and data phase overlap, AXI burst address arithmetic for INCR/WRAP/FIXED, VALID
held until READY on every channel, WLAST/RLAST placement, stream backpressure,
Avalon read-data ordering, Wishbone CYC/STB, I2C bit order and driver handover,
all four SPI modes, plus VCD output validity.

## Files

| file | what is in it |
| --- | --- |
| `protocols.mjs` | Every protocol as a per-cycle model. No DOM, no rendering. Emits `{signals, frames, markers, caption}`. |
| `waveform.mjs` | Generic renderer for that structure. Knows about clocks, bits, buses, tri-state, don't-care, groups and markers — not about any specific protocol. |
| `vcd.mjs` | VCD writer, so any waveform on the page opens in GTKWave. |
| `app.mjs` | Protocol index, controls, cycle inspector, compare view, exports. |
| `tests.mjs` | Node test suite for the protocol models and the VCD writer. |
| `index.html`, `styles.css` | Markup and figure styling. |
| `server.py` | Static server that registers the `.mjs` MIME type and falls back across ports. |

## How the model works

Each protocol emits one frame per clock cycle. A frame carries a phase label, a
note, and a map of signal name to value: `0`, `1`, `'z'`, `'x'`, a bus label, or
`{v, by, mid}` to override which side is driving in that cycle or to place a
transition mid-cell (I2C START and STOP conditions need this).

Nothing is inferred from signal names. Adding a protocol means writing its
frames; the renderer, the cycle inspector, the PNG export and the VCD export all
follow without changes.

Wait states, beat counts, burst type, SPI mode and clock stretching are model
inputs, not decorations — moving a slider regenerates the cycle sequence.

## Controls

Click any cycle to inspect it. Space plays, arrow keys step, `Home`/`End` jump.
Export the figure as PNG or the waveform as VCD. State lives in the URL hash.
