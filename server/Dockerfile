# obsidian-sync-plugins-server
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/obsidian-sync-plugins-server .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/obsidian-sync-plugins-server /usr/local/bin/

# 以 root 运行：兼容任意宿主挂载目录属主（与 xirang-sync 结论一致；
# 如需低权限运行，加 USER 并 chown 数据目录，否则 SQLite 会报 unable to open database file）
VOLUME /data
ENV OSPS_DB=/data/obsidian-sync.db \
    OSPS_BLOBS=/data/blobs \
    OSPS_BIND=0.0.0.0:8788
EXPOSE 8788
ENTRYPOINT ["obsidian-sync-plugins-server"]
