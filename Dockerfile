FROM public.ecr.aws/docker/library/node:20 AS build
WORKDIR /app
RUN npm install -g @angular/cli
COPY frontend/ .
RUN npm install
RUN npm run build --prod


FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=build /app/dist/boxertafel-frontend/browser/ ./static/

CMD uvicorn main:app --host 0.0.0.0 --port 8000 --log-level debug --reload
