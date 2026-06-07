{
  lib,
  stdenv,
  buildNpmPackage,
  fetchFromGitHub,
  makeWrapper,
  autoPatchelfHook,
  nghttp2,
}: let
  version = "0.39.0";
  packageHash = "sha256-0FHq8dZny4i3AhS4Xqy1CwNoN/F8nYQVIgHd5OdQ/NA=";
  depsHash = "sha256-f5ULuNKO+kb7aoYpxKsF/fHCbT2LLWwYnTN1VKVLgpY=";
in
  buildNpmPackage (finalAttrs: {
  pname = "claude-agent-acp";
  version = version;

  src = fetchFromGitHub {
    owner = "zed-industries";
    repo = "claude-agent-acp";
    tag = "v${finalAttrs.version}";
    hash = packageHash;
  };

  npmDepsHash = depsHash;

  nativeBuildInputs = [makeWrapper autoPatchelfHook];

  buildInputs = [stdenv.cc.cc.lib];

  postInstall = ''
    wrapProgram $out/bin/claude-agent-acp \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [nghttp2.lib]}
  '';

  meta = {
    description = "ACP-compatible coding agent powered by the Claude Code SDK";
    homepage = "https://github.com/zed-industries/claude-agent-acp";
    license = lib.licenses.asl20;
    maintainers = with lib.maintainers; [storopoli];
    mainProgram = "claude-agent-acp";
  };
})
