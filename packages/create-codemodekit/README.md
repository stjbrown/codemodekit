# create-codemodekit

Scaffold a runnable, one-file Code Mode MCP server from an upstream MCP command.

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx my-mcp-server'

cd my-code-mode
npm start
```

The command is parsed directly into an executable and argument array. Shell operators, shell expansion, and leading environment assignments are rejected; no shell is invoked. Dependency installation is automatic unless `--no-install` is supplied.

Generated servers use `--policy allow-all` by default so the project runs immediately. Use `--policy deny-all` when you want the generated server to start closed while you define a narrower tool policy.
