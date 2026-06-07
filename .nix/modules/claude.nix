{
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  state_dir = config.env.DEVENV_STATE;
  root_dir = config.env.DEVENV_ROOT;

  claude_dir = "${state_dir}/claude";
  hexdocs_dir = "${state_dir}/hexdocs";

  packages = pkgs.callPackage ../packages {};

  cfg = config.modules.claude;

  postgres-mcp = pkgs.writeShellScriptBin "postgres-mcp" ''
    set -euo pipefail

    # Auto-load .env if present (supports both KEY=VAL and export KEY=VAL formats)
    if [[ -f ".env" ]]; then
      set -a
      source .env
      set +a
    fi

    # Build DATABASE_URL from FUNSY_DATABASE_* env vars
    : "''${FUNSY_DATABASE_USER:?FUNSY_DATABASE_USER is not set}"
    : "''${FUNSY_DATABASE_PASSWORD:?FUNSY_DATABASE_PASSWORD is not set}"
    : "''${FUNSY_DATABASE_HOSTNAME:?FUNSY_DATABASE_HOSTNAME is not set}"
    : "''${FUNSY_DATABASE_PORT:?FUNSY_DATABASE_PORT is not set}"
    : "''${FUNSY_DATABASE_NAME:?FUNSY_DATABASE_NAME is not set}"

    DATABASE_URL="postgresql://''${FUNSY_DATABASE_USER}:''${FUNSY_DATABASE_PASSWORD}@''${FUNSY_DATABASE_HOSTNAME}:''${FUNSY_DATABASE_PORT}/''${FUNSY_DATABASE_NAME}"

    exec npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"
  '';
in {
  imports = [
    ./node.nix
  ];

  options = {
    modules.claude = {
      enable = mkEnableOption "Claude Code development";
      hexdocs.enable = mkEnableOption "Enable hexdocs MCP";
      postgres.enable = mkEnableOption "Enable postgres MCP";
    };
  };

  config = mkIf cfg.enable {
    packages =
      [pkgs.claude-code pkgs.ast-grep packages.claude-agent-acp]
      ++ optionals cfg.postgres.enable [postgres-mcp];

    env.CLAUDE_CONFIG_DIR = claude_dir;

    env.HEXDOCS_MCP_PATH = mkIf cfg.hexdocs.enable hexdocs_dir;
    env.HEXDOCS_MCP_MIX_PROJECT_PATHS = mkIf cfg.hexdocs.enable root_dir;

    env.TIDEWAVE_CLAUDE_AGENT_ACP_EXECUTABLE = "${packages.claude-agent-acp}/bin/claude-agent-acp";

    modules.node = mkIf cfg.hexdocs.enable {
      enable = mkForce true;
    };
  };
}
