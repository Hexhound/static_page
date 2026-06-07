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

  cfg = config.modules.rust;
in {
  options = {
    modules.rust = {
      enable = mkEnableOption "Rust development";

      package = mkOption {
        type = types.package;
        default = pkgs.rustc;
        defaultText = literalMD "pkgs.rustc";
        description = "The Rust package to use";
      };

      cargo = {
        package = mkOption {
          type = types.package;
          default = pkgs.cargo;
          defaultText = literalMD "pkgs.cargo";
          description = "The Cargo package to use";
        };
      };

      rustfmt = {
        package = mkOption {
          type = types.package;
          default = pkgs.rustfmt;
          defaultText = literalMD "pkgs.rustfmt";
          description = "The Rust Formatter package to use";
        };
      };
    };
  };

  config = mkIf cfg.enable {
    env.CARGO_HOME = "${state_dir}/cargo";

    languages.rust = {
      enable = true;

      toolchain = {
        rustc = cfg.package;
        cargo = cfg.cargo.package;
        rustfmt = cfg.rustfmt.package;
      };
    };

    packages = with pkgs-unstable; [
      cargo-tauri
      gsettings-desktop-schemas
      libayatana-appindicator
      libayatana-appindicator.dev
      glib
      glib.dev
      cairo
      cairo.dev
      pango
      pango.dev
      gdk-pixbuf
      gdk-pixbuf.dev
      gtk3
      gtk3.dev
      webkitgtk_4_1
      webkitgtk_4_1.dev
      openssl
      openssl.dev
      librsvg
      librsvg.dev
      libsoup_3
      libsoup_3.dev
      dbus
      dbus.dev
      at-spi2-atk
      at-spi2-atk.dev
      at-spi2-core
      at-spi2-core.dev
    ];

    enterShell = ''
      export LD_LIBRARY_PATH="${pkgs-unstable.libayatana-appindicator}/lib:''${LD_LIBRARY_PATH:-}"
      export XDG_DATA_DIRS="${pkgs-unstable.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs-unstable.gsettings-desktop-schemas.name}:${pkgs-unstable.gtk3}/share/gsettings-schemas/${pkgs-unstable.gtk3.name}:''${XDG_DATA_DIRS:-}"
    '';
  };
}
