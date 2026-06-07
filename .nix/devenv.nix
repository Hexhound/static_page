{
  pkgs,
  inputs,
  ...
}: let
  pkgs-unstable = import inputs.nixpkgs-unstable {
    system = pkgs.stdenv.system;
    config.allowUnfree = true;
  };
in {
  imports = [
    ./modules/claude.nix
    ./modules/devenv_utils.nix
    ./modules/elixir.nix
    ./modules/node.nix
    ./modules/rust.nix
    ./modules/cloudflare.nix
    ./modules/tidewave.nix
  ];

  modules.elixir = {
    enable = true;
    package = pkgs-unstable.elixir_1_19;

    erlang.package = pkgs-unstable.erlang_28;

    phoenix.enable = true;
  };

  modules.node = {
    enable = false;
    typescript.enable = true;
  };

  modules.claude = {
    enable = true;

    hexdocs.enable = true;
  };

  modules.rust.enable = true;

  modules.cloudflare.enable = true;

  modules.tidewave.enable = true;
}
