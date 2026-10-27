# Agent marks

OpenAI and Claude monochrome marks from `@lobehub/icons-static-svg` 1.95.0 (MIT).
Source: https://icons.lobehub.com/ (upstream: https://github.com/lobehub/lobe-icons)
Vendored from https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.95.0/icons/openai.svg and https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.95.0/icons/claude.svg.
Served locally; no external requests or font dependency. Marks identify supported integrations and model families, not a partnership.

The native invitation uses the OpenAI source outline as one filled polygon with
transparent counters. Its generated vertices live in `canvas/agentInvitationMarks.ts`;
SVG path normalization and `points-on-path` flattening happen offline. Keep the
outline intact instead of tracing its junctions into pressure strokes. Claude
retains the native pressure-ink treatment. Both marks remain editable canvas
elements, excluded from artwork until duplicated by the user.
