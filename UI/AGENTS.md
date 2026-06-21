# AI Coding Instructions: High-Precision Editing via Hashline

Every AI model (including Gemini, Claude, GPT, etc.) working in this workspace MUST adhere to the **Hashline-based code editing protocol** inspired by the [mcp-hashline-edit-server](https://github.com/Submersible/mcp-hashline-edit-server.git) (referenced as original licensed work under standard developer acknowledgement).

## Core Principles

To eliminate high latency, truncated file generations, and accidental syntax corruptions:
1. **NEVER overwrite entire files** unless building a new module from scratch.
2. **USE line-addressed anchoring** for precision: locate the exact lines where modifications start and end.
3. Apply changes via **atomic diffs** and targeting blocks:

### Simulated Hashline-Edit Commands
When you perform file edits, think and structure your tool calls like the four classic hashline edit commands:
- **Set Line**: Target exactly one line by context anchor and line content.
  - *Example:* Replace the line containing a flawed condition with a clean check.
- **Replace Lines**: Frame the sequence from a start anchor line to an end anchor line.
  - *Example:* Swapping out an entire function body without touching adjacent classes.
- **Insert After**: Append new functions or state variables safely immediately below a known identifier anchor.
  - *Example:* Placing a new subcomponent or helper hook safely inside an established React file.
- **Strict Matching**: Every target block must match *exactly* including leading whitespace to prevent "Target content not found" errors.

## Compliance
Before executing any edit, refer to `/docs/MCP_INTEGRATION.md` for proper compliance, references, and specifications.

## Floating Panel Design Standard (浮动面板设计标准)
All interactive floating, drag-and-drop, and resizable panels or modals within this application MUST adhere to the following implementation standards:
1. **Direct Dimension Sizing (直接物理宽高控制)**: Always adjust the container's physical `width` and `height` properties in React state during drag/resize operations. Do NOT use CSS `scale(...)` scale factor transforms, which introduce cursor-to-edge calculation gaps, blur text, and break child element mouse click captures.
2. **Four-Corner Active Touchpoints (四个角的触控把手)**: Each resizable panel must have clear overlapping visual corner handles (e.g., width & height `w-6 h-6` with precise SVG/CSS border anchors like `border-t-2 border-l-2`) placed at high z-index layers.
3. **Responsive Visual Cues (悬浮反馈和光标)**: Corners must show clear interactive pointer cursors (`cursor-nwse-resize`, `cursor-nesw-resize`) and respond dynamically to hover (`hover:scale-110` or border color shifts) to optimize the user experience.

