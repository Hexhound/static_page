{pkgs, ...}: {
  tidewave-cli = pkgs.callPackage ./tidewave_cli.nix {
    claude-agent-acp = pkgs.callPackage ./claude_agent_mcp.nix {};
  };
  claude-agent-acp = pkgs.callPackage ./claude_agent_mcp.nix {};
}
