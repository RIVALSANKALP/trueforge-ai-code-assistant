import matplotlib.pyplot as plt
import matplotlib.patches as patches

def generate_diagram(output_path):
    # Set high DPI and professional canvas
    fig, ax = plt.subplots(figsize=(10.5, 4.2), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 42)
    ax.axis('off')

    # Background color
    fig.patch.set_facecolor('#FFFFFF')
    ax.set_facecolor('#FFFFFF')

    # Color palette
    navy_border = '#0F2942'
    navy_header = '#0F2942'
    accent_blue = '#1E6091'
    box_bg_vscode = '#F8FAFC'
    box_bg_trueforge = '#F0F9FF'
    box_bg_llm = '#FEF3C7'
    box_bg_fs = '#F1F5F9'
    text_dark = '#1E293B'
    text_muted = '#64748B'

    # Box 1: VS Code Extension Host (Left)
    rect_vscode = patches.FancyBboxPatch((2, 3), 44, 36,
                                         boxstyle="round,pad=0.5,rounding_size=1.5",
                                         facecolor=box_bg_vscode, edgecolor='#CBD5E1', linewidth=1.5)
    ax.add_patch(rect_vscode)
    ax.text(24, 36.8, "VS Code Extension Host (FORGEX Client)", ha='center', va='center',
            fontsize=10.5, fontweight='bold', color=navy_header)

    # Sub-components inside VS Code
    # 1. UI & Inline Diff
    rect_ui = patches.FancyBboxPatch((4, 26), 19, 8, boxstyle="round,pad=0.3,rounding_size=1",
                                     facecolor='#FFFFFF', edgecolor='#94A3B8', linewidth=1)
    ax.add_patch(rect_ui)
    ax.text(13.5, 31.2, "Sidebar Chat & Inline Edit", ha='center', va='center', fontsize=8.5, fontweight='bold', color=text_dark)
    ax.text(13.5, 28.2, "Diff Review (trueforge-diff://)\nPending Proposal Queue", ha='center', va='center', fontsize=7.2, color=text_muted)

    # 2. Context & Assembly
    rect_ctx = patches.FancyBboxPatch((25, 26), 19, 8, boxstyle="round,pad=0.3,rounding_size=1",
                                      facecolor='#FFFFFF', edgecolor='#94A3B8', linewidth=1)
    ax.add_patch(rect_ctx)
    ax.text(34.5, 31.2, "Context Discovery & Assembler", ha='center', va='center', fontsize=8.5, fontweight='bold', color=text_dark)
    ax.text(34.5, 28.2, "3,500 Token Budget Cap\nFail-Closed Security Boundary", ha='center', va='center', fontsize=7.2, color=text_muted)

    # 3. Autonomous Coordinator
    rect_coord = patches.FancyBboxPatch((4, 15), 40, 8.5, boxstyle="round,pad=0.3,rounding_size=1",
                                        facecolor='#FFFFFF', edgecolor=accent_blue, linewidth=1.2)
    ax.add_patch(rect_coord)
    ax.text(24, 20.8, "Autonomous Agent Coordinator (Client-Side Orchestrator)", ha='center', va='center', fontsize=8.8, fontweight='bold', color=accent_blue)
    ax.text(24, 17.5, "Multi-Turn Tool Dispatch Loop • Loop Detection • Cancellation Token Binding • Zero Direct Disk Writes",
            ha='center', va='center', fontsize=7.2, color=text_dark)

    # 4. Local Loopback MCP Server
    rect_mcp = patches.FancyBboxPatch((4, 5.5), 40, 7.5, boxstyle="round,pad=0.3,rounding_size=1",
                                      facecolor='#EFF6FF', edgecolor='#3B82F6', linewidth=1.2)
    ax.add_patch(rect_mcp)
    ax.text(24, 10.5, "Local MCP Bridge (http://127.0.0.1:8799/mcp)", ha='center', va='center', fontsize=8.5, fontweight='bold', color='#1D4ED8')
    ax.text(24, 7.8, "Tools: list_files, read_file, search_code, propose_edit\nConstant-Time Ephemeral Bearer Auth • Host-Header Guard",
            ha='center', va='center', fontsize=7, color='#1E40AF')

    # Box 2: TrueForge Local Runtime (Middle-Right)
    rect_tf = patches.FancyBboxPatch((52, 14), 28, 25,
                                    boxstyle="round,pad=0.5,rounding_size=1.5",
                                    facecolor=box_bg_trueforge, edgecolor='#93C5FD', linewidth=1.5)
    ax.add_patch(rect_tf)
    ax.text(66, 36.8, "TrueForge Local Engine (:8790)", ha='center', va='center',
            fontsize=10.5, fontweight='bold', color=navy_header)

    # Sub-components inside TrueForge
    rect_agent = patches.FancyBboxPatch((54, 27), 24, 7, boxstyle="round,pad=0.3,rounding_size=1",
                                        facecolor='#FFFFFF', edgecolor='#60A5FA', linewidth=1)
    ax.add_patch(rect_agent)
    ax.text(66, 31.8, "Agent Harness ('forgeagent')", ha='center', va='center', fontsize=8.5, fontweight='bold', color=text_dark)
    ax.text(66, 29.2, "Instruction Prompts • Tool Schema Validation", ha='center', va='center', fontsize=7.2, color=text_muted)

    rect_session = patches.FancyBboxPatch((54, 16.5), 24, 8.5, boxstyle="round,pad=0.3,rounding_size=1",
                                          facecolor='#FFFFFF', edgecolor='#60A5FA', linewidth=1)
    ax.add_patch(rect_session)
    ax.text(66, 22.2, "Turn & Session Manager", ha='center', va='center', fontsize=8.5, fontweight='bold', color=text_dark)
    ax.text(66, 19.8, "SSE Event Streaming (turn.created, deltas)", ha='center', va='center', fontsize=7.2, color=text_muted)
    ax.text(66, 17.8, "Remote MCP Connector ('vscode-tools')", ha='center', va='center', fontsize=7.2, color='#2563EB')

    # Box 3: LLM Provider (Top Right)
    rect_llm = patches.FancyBboxPatch((84, 27), 14, 12,
                                     boxstyle="round,pad=0.4,rounding_size=1.2",
                                     facecolor=box_bg_llm, edgecolor='#F59E0B', linewidth=1.2)
    ax.add_patch(rect_llm)
    ax.text(91, 36.2, "LLM Gateway", ha='center', va='center', fontsize=9.2, fontweight='bold', color='#92400E')
    ax.text(91, 32.5, "Gemini 3.5 Flash Lite\n(reasoning: low)", ha='center', va='center', fontsize=8, color='#78350F')
    ax.text(91, 29.2, "[Provider-Agnostic\nvia TrueForge]", ha='center', va='center', fontsize=6.8, color='#B45309')

    # Box 4: Workspace Filesystem / Benchmark Target (Bottom Right)
    rect_target = patches.FancyBboxPatch((52, 3), 46, 8.5,
                                        boxstyle="round,pad=0.4,rounding_size=1.2",
                                        facecolor=box_bg_fs, edgecolor='#94A3B8', linewidth=1.2)
    ax.add_patch(rect_target)
    ax.text(75, 9.2, "Evaluation Target: Pallets Flask 3.1.3 (commit 22d92470)", ha='center', va='center',
            fontsize=8.5, fontweight='bold', color=text_dark)
    ax.text(75, 6.2, "Controlled Workspace: helpers.py (Task A), cli.py / test_cli.py / cli.rst (Task B)\nZero Pre-Approval Writes • Explicit Human Review Gate",
            ha='center', va='center', fontsize=7.2, color=text_muted)

    # Arrows & Connections
    # 1. VS Code -> TrueForge (Sessions / Turns)
    ax.annotate('', xy=(52, 28), xytext=(46, 28),
                arrowprops=dict(arrowstyle="->", color=accent_blue, lw=1.8))
    ax.text(49, 29.2, "REST / SSE", ha='center', va='bottom', fontsize=6.8, fontweight='bold', color=accent_blue)

    # 2. TrueForge -> Local MCP Bridge (Tool Calls via HTTP)
    ax.annotate('', xy=(44, 9), xytext=(54, 18),
                arrowprops=dict(arrowstyle="->", color='#2563EB', lw=1.5, ls='--'))
    ax.text(49, 13.5, "tools/call (MCP)", ha='center', va='center', fontsize=6.8, fontweight='bold', color='#2563EB')

    # 3. TrueForge <-> LLM
    ax.annotate('', xy=(84, 33), xytext=(78, 33),
                arrowprops=dict(arrowstyle="<->", color='#D97706', lw=1.5))
    ax.text(81, 34.2, "Inference", ha='center', va='bottom', fontsize=6.8, color='#92400E')

    # 4. Local Bridge -> Evaluation Target
    ax.annotate('', xy=(52, 7.5), xytext=(44, 7.5),
                arrowprops=dict(arrowstyle="->", color='#059669', lw=1.5))
    ax.text(48, 6.2, "Safe Staging", ha='center', va='top', fontsize=6.8, color='#059669')

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()
    print(f"Diagram generated successfully at: {output_path}")

if __name__ == '__main__':
    generate_diagram("D:/TrueForge-Forgeathon/submission/architecture_diagram.png")
