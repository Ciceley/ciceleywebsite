# Ciceley site — production image.
#
# The Hugo site is built on the runner (see .github/workflows/deploy.yml) and
# the generated ./public directory is copied in. To build locally:
#
#   nix develop -c hugo --minify
#   docker build -t ciceley-site .
#
FROM docker.io/library/nginx:alpine

RUN rm -rf /usr/share/nginx/html/*

COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY public/ /usr/share/nginx/html/

RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:80/ || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
