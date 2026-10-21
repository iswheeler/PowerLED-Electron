# Reverse-engineered formats

Sources: `PowerLed.exe` (UPX-packed MSVC/MFC, unpacked and disassembled), `language/en-us.dll` (string table), real
`.ledprj` files, and four real USB exports (three 128×16 test exports that differ only in their text, plus a backup
from a physical sign with two programs and scrolling text).
**V** = verified byte-for-byte against the samples, **C** = read from the disassembly but not confirmed by a sample,
**A** = assumption.

## .ledprj, "project ver=2" (native format of this exe)  **V**

`<project ver="2">` wraps one root `<LongGreat>`. Each node: `<long>` type, `<great>` name, `<fore>` ticked, `<slt>`
selected, then flat property elements, then child nodes.

| long | node | notes |
|---|---|---|
| 0 | root | |
| 120 | panel | `pw` width, `ph1` height, `pc` colour planes (1 R, 2 RG, 3 RGB), `pf`, `ph2`, `ps`, `pwb`… (see below) |
| 110 | program | `pt` play mode, `time`, `sd/ed` dates, `st/et` times, `wk` week mask |
| 100 | window | `rect="l,t,r,b"` (note: stored as right/bottom, not width/height) |
| 1 | text page | `action`, `speed`, `delay`, `bkcr`, `clear`, `rtf`, `sm`, `va`, `line`, `top` |
| 2 | media page | same header fields, `ip00` remove-colour, `ip01` position, `ip02/03` limit/range, `ip04` path |
| 11 | date/time | opaque to the editor |

**Canvas pages** (this app's extension): a type-2 media node with an empty `ip04` and an extra `<cvpng>` property
holding the painted pixels as a base64 PNG. To the exporter it is just an image; PowerLed ignores the extra tag but
then sees an image page with no file, so canvases are only fully editable in this app.

Colours are Win32 COLORREF (`0x00BBGGRR`). Dates are `0x80000000 | days-since-1970` when "unlimited". The window
`fore` flag is 0 in every real file even though the window plays, so it is ignored. `delay` is assumed to be in 10 ms
units (**A**; the export writes it unchanged, which is what the samples contain).

The newer `<led595 version="3">` schema is not produced by this exe; it is imported on a best-effort basis (**A**).

## Files on the USB disk  **V**

```
<disk>/LED.TFR                (optional) controller readback / parameter file, 0x84 bytes
<disk>/POWERLED/Readme.txt    UTF-16LE (BOM) warning text, identical in every export
<disk>/POWERLED/LED.TFU       the program file
<disk>/POWERLED/<w><h><c>.TFU the *same bytes* again, named width+height+planes (e.g. 128,16,2 -> 128162.TFU)
```
`LED.TFU` and `128162.TFU` are byte-identical in all four real exports (checked with `cmp`); the dimension-named copy
is what a card of that size looks for, `LED.TFU` is the generic name.

## .TFU (USB program file)

```
file    = sector[0x200] + stream[N * 0x1000]
```

### Header sector  **V**
All 512 bytes are random filler `(rand%128)|0x80`, except:

| offset | size | value |
|---|---|---|
| 0x32 | u8 | random `< 0x40` |
| 0x34 | u32 | stream length (multiple of 0x1000) |
| 0x38 | u32 | max over programs of Σ windows `h × alignTo32(w) × planes / 8` |
| 0x3C | u16 | `0x59A5` |
| 0x40 / 0x42 | u16 | panel width / height |
| 0x46 / 0x47 | u8 | `1` / `0` |
| 0x90 | 0x70 | panel parameter block (below) |

### Panel parameter block (0x70)  **V**
Same struct as `LED.TFR[0x10:0x80]` (the controller's own readback). MAC (0x1A..0x1F) is zero in exports.

```
00 u32 pde(baud)  04 u16 pp(id)  06 u16 pw  08 u16 ph1  0A pc  0B pd  0C po1  0D pl  0E pr4  0F pf  10 ph2
11 ps  12 pwb  13 po2  14..17 pr0..pr3  18 u16 ilp  1A MAC[6]  20 ili[4]  24 ilg[4]  28 ils[4]  2C ilo[4]
38 ss2  39 ss1  3A sr0  3B sr1  3C 4×{u16 si4n, u16 si2n, u8 si5n}  50 ll1  51 ll2  52 6×{u16 ll4n, u16 ll2n, u8 ll5n}
```
(Tag → offset taken from the member offsets PowerLed uses when saving the project; reproduces all four samples.)

### Stream  **V**
```
key[0x80]            filler; [0x46]=1 [0x47]=0 [0x48..4B]=0; [0x7B]=0x37+rand%50; [0x7C]=rand;
                     [0x7D]=0x55-[0x7C]-n; [0x7E]=rand; [0x7F]=n-[0x7E]     (n = number of programs)
u32 programOffset[n] absolute stream offsets
program records...
random padding to a multiple of 0x1000
```
Program record: 0x1BC-byte header then each window's pages.
```
00 u16 time (3..65535)  02 u8 playtype  03 u8 week (bit7 => 0xFF)
04 startDate 08 endDate 0C startTime 10 endTime   (flagged "unlimited" => start=0, end=0xFFFFFFFF)
14.. custom-frame data (not exported)
D8   16 × { u32 pageOffset(absolute), u16 x, y, w, h }   (index = window index; unused => zero)
198  01 5A 01 00      19C 16 × u16 window-border words (0 = none)
```
Page: 0x14 header, then frames.
```
00 u32 0   04 u16 delay of frame 0   06 u8 frame count   07 u8 kind (1 text, 2 media)   08 u8 clear
09 u8 action (v2 action > 5 ? action-1 : action)   0A u8 speed   0E u16 text width   (rest 0)
frame = { u16 delay, u16 0 } + planes × h × stride bytes
```
`delay` is 0 for continuous-move actions (3, 5). Text width (**A**, fits all samples): content width of the last
frame + 15.

### Bitmap  **V**
One plane per colour (R, G, B), `planes = pc`. Each row is padded to 32 px (`stride = ceil(w/32)*4`), bit 0 of byte 0
is the leftmost pixel, **1 = LED off**. Continuous-move text is one wide strip cut into window-wide frames.
Pixels are on when the channel is ≥ 128 (single-colour panels: when any channel is). (**A** for the threshold.)

## LED.TFR (controller readback, 0x84 bytes)  **C**
`u32 0x84`, version bytes, the 0x70 parameter block at 0x10, trailing 4 bytes. Only read (for its parameter block).

## Open questions
- Page types other than text/image (clock, date/time, countdown, temperature, table, animate): different page records.
- Whether the card applies the parameter block in the `.TFU` or only the one in `LED.TFR` (the original has an
  "Include panel parameters" option that also writes `LED.TFR`).
- Exact text-width field semantics, and the per-frame second `u16`.
