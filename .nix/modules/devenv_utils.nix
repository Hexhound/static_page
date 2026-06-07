{
  config,
  lib,
  pkgs,
  ...
}: {
  config = {
    scripts.dev.exec = ''
      pushd ${config.env.DEVENV_ROOT} > /dev/null
      eval $(which devenv) $@
      popd > /dev/null
    '';

    enterShell = ''
      echo "Devenv usage:"
      echo -e "\tRun 'dev up' to setup devenv"
      echo -e "\tRun 'dev info' to get info about env"
      echo ""
    '';
  };
}
