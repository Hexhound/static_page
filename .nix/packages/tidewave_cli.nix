{
  lib,
  pkgs,
  rustPlatform,
  fetchFromGitHub,
  pkg-config,
  openssl,
  makeWrapper,
  claude-agent-acp,
  ...
}: let
  version = "0.4.4";
  packageHash = "sha256-BR7+M+sWpsXMwdTMgvci/wRAjwT54KJhP67ahfMQZfg=";
  cargoHash = "sha256-JKoAkKx3W257Py5m6wrBdFC88Di8irs7iQ4C10xbVCo=";

  src = pkgs.applyPatches {
    nativeBuildInputs = [pkgs.perl];

    src = fetchFromGitHub {
      owner = "tidewave-ai";
      repo = "tidewave_app";
      rev = "v${version}";
      hash = packageHash;
    };

    postPatch = ''
      # Remove src-tauri from workspace to avoid pulling in GUI/tao dependencies
      substituteInPlace Cargo.toml \
        --replace-warn '    "src-tauri",' ""

      # Remove [patch.crates-io] section that overrides tao with a git fork
      substituteInPlace Cargo.toml \
        --replace-warn $'[patch.crates-io]\n# TODO: upstream\ntao = { git = "https://github.com/wojtekmach/tao.git", branch = "wm-bundled-activation-policy" }' ""

      # Remove git-sourced tao entry from Cargo.lock — avoids duplicate
      # tao-macros-0.1.3 collision between crates.io and git versions
      perl -0777 -i -pe \
        's/\[\[package\]\]\nname = "tao"\nversion = "[^"]+"\nsource = "git\+https:\/\/github\.com\/wojtekmach\/tao\.git[^\n]*\n.*?(?=\n\[\[package\]\])//s' \
        Cargo.lock

      # Remove git-sourced tao-macros entry from Cargo.lock
      perl -0777 -i -pe \
        's/\[\[package\]\]\nname = "tao-macros"\nversion = "[^"]+"\nsource = "git\+https:\/\/github\.com\/wojtekmach\/tao\.git[^\n]*\n.*?(?=\n\[\[package\]\])//s' \
        Cargo.lock
    '';
  };
in
  rustPlatform.buildRustPackage {
    pname = "tidewave";
    version = version;

    inherit src;

    cargoHash = cargoHash;

    # Build only the CLI crate, not the Tauri desktop app
    buildAndTestSubdir = "tidewave-cli";

    nativeBuildInputs = [
      pkg-config
      makeWrapper
    ];

    buildInputs = [
      openssl
    ];

    postInstall = ''
      wrapProgram $out/bin/tidewave \
        --set TIDEWAVE_CLAUDE_AGENT_ACP_EXECUTABLE "${claude-agent-acp}/bin/claude-agent-acp"
    '';

    meta = with lib; {
      description = "Tidewave CLI";
      homepage = "https://github.com/tidewave-ai/tidewave_app";
      license = licenses.asl20;
      maintainers = [];
      platforms = platforms.linux ++ platforms.darwin;
      mainProgram = "tidewave";
    };
  }
