## Vue Language Server

For use with Theia-IDE

`vue-language-server` extracted from [vetur/server](https://github.com/vuejs/vetur/tree/master/server)

Vue Language Server offers multiple features which you can check from the link above. However, this features often requires a vscode builtin extension to be present.
Since Theia does not install vscode-builtin extensions by default, this repo instead uses the default configurations for the required builtin extensions.
You can check the default configurations here, [builtInConfigs.ts](https://github.com/Devpodio/vue-language-server/tree/master/src/builtInConfigs)


### Customizing builtin extensions

To be able to customize the builtin extensions, you must install the required extensions below.

- [vscode-builtin-html-language-features](https://www.npmjs.com/package/@theia/vscode-builtin-html-language-features)
- [vscode-builtin-css-language-features](https://www.npmjs.com/package/@theia/vscode-builtin-css-language-features)
- [vscode-builtin-emmet](https://www.npmjs.com/package/@theia/vscode-builtin-emmet)

### To install the builtin extensions

- run `npm view @theia/vscode-builtin-xxx` (replace it with correct extension from the above)
- this will show you the tarball link to download
- download this tarball link and place it on Theia's default plugin folder