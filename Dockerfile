# Build context must be the PARENT directory (compose sets `context: ..`)
# so both this project and the movies-series-fetcher sibling are available —
# the addon depends on it via `file:../movies-series-fetcher`.

FROM node:22-alpine AS build
WORKDIR /build

# package files first so dependency layers cache across source edits
COPY movies-series-fetcher/package.json movies-series-fetcher/package-lock.json movies-series-fetcher/
COPY polish-http-stremio-addon/package.json polish-http-stremio-addon/package-lock.json polish-http-stremio-addon/
RUN cd movies-series-fetcher && npm ci
RUN cd polish-http-stremio-addon && npm ci

COPY movies-series-fetcher/ movies-series-fetcher/
COPY polish-http-stremio-addon/ polish-http-stremio-addon/

RUN cd movies-series-fetcher && npm run build
RUN cd polish-http-stremio-addon && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# same layout as /build so the addon's `file:../movies-series-fetcher`
# symlink inside node_modules keeps resolving
COPY --from=build /build/movies-series-fetcher/package.json movies-series-fetcher/package.json
COPY --from=build /build/movies-series-fetcher/dist movies-series-fetcher/dist
COPY --from=build /build/movies-series-fetcher/node_modules movies-series-fetcher/node_modules
COPY --from=build /build/polish-http-stremio-addon/package.json package.json
COPY --from=build /build/polish-http-stremio-addon/dist dist
COPY --from=build /build/polish-http-stremio-addon/node_modules node_modules
# npm's `file:`-dep symlink (`../../movies-series-fetcher`, correct in the
# build layout) dangles here — recreate it for /app's shallower layout
RUN rm node_modules/movies-series-fetcher && \
    ln -s ../movies-series-fetcher node_modules/movies-series-fetcher

EXPOSE 7777
CMD ["node", "dist/server.js"]
