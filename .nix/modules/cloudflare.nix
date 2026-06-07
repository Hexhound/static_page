{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
with lib; let
  cfg = config.modules.cloudflare;
in {
  options = {
    modules.cloudflare = {
      enable = mkEnableOption "Cloudflare development tools";

      wrangler = {
        package = mkOption {
          type = types.package;
          default = pkgs.wrangler;
          defaultText = literalMD "pkgs.wrangler";
          description = "The Wrangler package to use";
        };
      };
    };
  };

  config = mkIf cfg.enable {
    packages = [cfg.wrangler.package];
  };
}
