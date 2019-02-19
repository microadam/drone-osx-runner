FROM node:10.15.1-alpine

RUN apk add --update zstd tar --repository http://dl-3.alpinelinux.org/alpine/edge/main && rm -rf /var/cache/apk/*

WORKDIR /app
COPY . .

RUN yarn

CMD /usr/local/bin/node /app/client.js