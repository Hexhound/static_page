{
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  packages = pkgs.callPackage ../packages {};

  cfg = config.modules.tidewave;
in {
  options = {
    modules.tidewave.enable = mkEnableOption "Tidewave development";
  };

  config = mkIf cfg.enable {
    packages = [packages.tidewave-cli];
  };
}
