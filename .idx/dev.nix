{ pkgs, ... }: {
  channel = "stable-24.05";
  packages = [
    pkgs.nodejs_20
  ];
  idx = {
    extensions = [
      "dbaeumer.vscode-eslint"
    ];
    workspace = {
      onCreate = {
        npm-install = "npm install";
      };
      onStart = {};
    };
    previews = {
      enable = true;
      previews = {
        web = {
          command = ["node" "addon.js"];
          port = 7000;
          manager = "web";
        };
      };
    };
  };
}
