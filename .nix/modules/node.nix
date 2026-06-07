{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
with lib; let
  pkgs-unstable = import inputs.nixpkgs-unstable {system = pkgs.stdenv.system;};

  state_dir = config.env.DEVENV_STATE;

  cfg = config.modules.node;
in {
  options = {
    modules.node = {
      enable = mkEnableOption "Node development";

      package = mkOption {
        type = types.package;
        default = pkgs.nodejs-slim;
        defaultText = literalMD "pkgs.nodejs-slim";
        description = "The Node package to use";
      };

      typescript = {
        enable = mkEnableOption "Typescript development";

        package = mkOption {
          type = types.package;
          default = pkgs.typescript;
          defaultText = literalMD "pkgs.typescript";
          description = "The Typescript package to use";
        };
      };
    };
  };

  config = mkIf cfg.enable {
    env.NPM_CONFIG_CACHE = "${state_dir}/npm";
    env.NODE_REPL_HISTORY = "${state_dir}/node_repl_history";

    languages.javascript = {
      enable = true;
      npm.enable = true;

      package = cfg.package;
    };

    packages = lists.optionals cfg.typescript.enable [cfg.typescript.package] ++ [pkgs.prettier];
  };
}
