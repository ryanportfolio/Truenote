# Image for the `scanner` service: ClamAV (clamd plus freshclam signature
# updates) behind a small HTTP wrapper (server.mjs) that implements the
# scanner contract of artifacts/api-server/src/lib/security/content-scan.ts.
# Reached only over Railway's private network; no public domain.
#
# Base: Cisco's official ClamAV image, 1.4 LTS on Debian trixie, pinned by
# digest. It ships with a signature database, so the first start needs only
# freshclam's incremental update. Bump the digest for ClamAV patch releases.
# Node comes from the official Node 22 image on the same Debian release.
# Build context: the repository root (RAILWAY_DOCKERFILE_PATH=services/scanner/Dockerfile).
FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS node

FROM clamav/clamav-debian:1.4.6@sha256:6d0680780fd29855cb7018f68272cb520821f614259e2066f8ec669069ac91b3
# Debian security fixes released after the base image was built.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY services/scanner/clamd.conf services/scanner/freshclam.conf services/scanner/entrypoint.sh services/scanner/server.mjs /opt/scanner/
# The database directory is the clamav user's home (uid 1000) in the base image.
RUN chmod 0755 /opt/scanner/entrypoint.sh \
 && chown -R clamav:clamav /var/lib/clamav \
 && node --version
USER clamav
ENV TZ=Etc/UTC \
    PORT=8080
EXPOSE 8080
HEALTHCHECK --start-period=5m CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{process.exitCode=r.ok?0:1}).catch(()=>{process.exitCode=1})"
ENTRYPOINT ["/opt/scanner/entrypoint.sh"]
