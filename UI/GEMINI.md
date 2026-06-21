# Gemini Specific Instructions: Hashline Code Editing Protocol

This repository is optimized for **Hashline editing performance** inspired by [mcp-hashline-edit-server](https://github.com/Submersible/mcp-hashline-edit-server.git).
As a Gemini coding model, you MUST follow these specific guidelines:

1. **Precision Surgical Edits**: Use strict line matching and minimal replacement segments. Do not rewrite surrounding functions or empty lines.
2. **Anchor Stability**: Ensure your `TargetContent` block for edits has clear, unique leading and trailing anchor lines. Any ambiguity in matching will fail.
3. **No-Op Avoidance**: Ensure the code you are outputting actually introduces functional changes compared to what is currently visible in the source file.
4. **MIT Acknowledgment**: For more details, consult `/docs/MCP_INTEGRATION.md` for our open-source integration reference.
