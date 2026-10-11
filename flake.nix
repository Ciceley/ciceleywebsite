{
  description = "Ciceley website — Hugo (Stack theme) with content synced from Notion";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Theme is also vendored as a git submodule (see .gitmodules) for local/CI use.
    stack-theme = {
      url = "github:CaiJimmy/hugo-theme-stack/v4.0.3";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, stack-theme }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              hugo # nixpkgs hugo is the extended build (sass + esbuild)
              nodejs
              gh
              git
              jq
            ];
            shellHook = ''
              echo "Hugo $(hugo version | cut -d' ' -f2)"
              echo "Run 'npm install' once, then 'npm run dev' for a local preview."
            '';
          };
        });

      # `nix build .#site` produces ./result/ containing the generated static files.
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          site = pkgs.stdenv.mkDerivation {
            pname = "ciceley-site";
            version = "0.1.0";
            src = self;
            nativeBuildInputs = [ pkgs.hugo ];

            buildPhase = ''
              runHook preBuild
              rm -rf themes/hugo-theme-stack
              mkdir -p themes
              cp -r ${stack-theme} themes/hugo-theme-stack
              chmod -R u+w themes
              hugo --minify --destination "$out"
              runHook postBuild
            '';

            dontInstall = true;
          };
          default = self.packages.${system}.site;
        });
    };
}
