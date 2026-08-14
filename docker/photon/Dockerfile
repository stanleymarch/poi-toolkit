FROM eclipse-temurin:21-jre-jammy
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
WORKDIR /photon
RUN wget -q "https://github.com/komoot/photon/releases/download/1.2.1/photon-1.2.1.jar" -O photon.jar
ENV PHOTON_DATA_DIR=/photon/photon_data
EXPOSE 2322
# Legacy PBF import: java -jar photon.jar -import /data/pfo.osm.pbf -languages ru,en
# Serve:             java -jar photon.jar serve -listen-ip 0.0.0.0 -listen-port 2322 -languages ru,en
ENTRYPOINT ["java", "-Xmx4g", "-jar", "photon.jar"]
