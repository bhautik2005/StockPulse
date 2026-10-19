FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=http://localhost:5000
ARG VITE_CSRF_COOKIE=sp_csrf
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_CSRF_COOKIE=${VITE_CSRF_COOKIE}

RUN npm run build

FROM nginx:stable-alpine AS production

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]
