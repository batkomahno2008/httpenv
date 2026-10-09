# httpenv

Tiny HTTP server showing the environment variables on TCP 8080.

[![CI](https://github.com/batkomahno2008/httpenv/actions/workflows/basic-docker-build-v2.yaml/badge.svg?branch=main)](https://github.com/batkomahno2008/httpenv/actions/workflows/basic-docker-build-v2.yaml)

Images for `linux/x86_64` (amd64), `linux/arm64` (v8), and `linux/arm/v7`

This can be used for various container learnings like how DNS round-robin works, rolling updates, etc.
It can be easier to use than something large and resource hungary like elasticsearch, while still providing
a way to check which container you're seeing in browser (or `curl`) by viewing the env vars it returns in HTTP.

Run it from GitHub Container Registry (GHCR) on host port 8080:

`docker run -d -p 8080:8080 ghcr.io/batkomahno2008/httpenv`

Image tags: `latest` (current `main`), `sha-<short-commit>` (every `main` build), and `X.Y.Z` / `X.Y` for `vX.Y.Z` release tags.

If you `curl` it, you should get back its environment variables, including the container name:

```shell
curl http://localhost:8080

{"HOME":"/root","HOSTNAME":"c9d8d26bda3a","PATH":"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
```
