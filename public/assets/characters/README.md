# Character art assets (official PAIPAI IP)

Drop official Kuaishou KID Design Center renders here (transparent PNG, roughly square):

- `paipai.png`        — used verbatim as the in-game runner sprite (scaled + per-mode
                        hue-rotation only; the artwork itself is never redrawn).
                        Also used as the fallback art for all selection boxes.
- `{mode}.png`         — optional per-mode override for the selection boxes:
                        overall.png, techops.png, hr.png, pm.png, project.png,
                        design.png, culture.png, ai.png
                        (following the ORIEstar approach: reuse the same characters
                        with color changes — export recolored variants rather than
                        new characters.)

Until these files exist, the game renders a built-in placeholder mascot so
everything stays playable.
