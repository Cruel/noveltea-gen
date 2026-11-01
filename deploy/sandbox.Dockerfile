# Deliberately minimal offline tool environment. Pin the built image ID at
# controller acquisition; no app, Git, credentials or Docker CLI is installed.
FROM alpine:3.22
RUN apk add --no-cache bash coreutils findutils grep
WORKDIR /story
# Root inside the rootless daemon's user namespace maps to a NON-root host uid.
# The deployment controller drops all capabilities and disables the network.
CMD ["sleep","infinity"]
