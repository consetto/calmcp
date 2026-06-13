# Multi-stage build for the calmcp MCP server.
# Stage 1 compiles TypeScript; stage 2 ships only production dependencies and the built output.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Streamable HTTP transport for container/remote deployment.
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/index.js", "--http"]
