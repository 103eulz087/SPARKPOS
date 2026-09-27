# ---------- 1. build the React front end ----------
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 2. build the .NET API ----------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS apibuild
WORKDIR /src
COPY src/PosApi/ ./PosApi/
RUN dotnet publish PosApi/PosApi.csproj -c Release -o /out

# ---------- 3. runtime: the API serves the SPA from wwwroot ----------
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=apibuild /out ./
COPY --from=webbuild /web/dist ./wwwroot
EXPOSE 5000
ENV ASPNETCORE_URLS=http://0.0.0.0:5000
ENTRYPOINT ["dotnet", "PosApi.dll"]
