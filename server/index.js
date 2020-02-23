const http = require("http");
const Controller = require("./controller");

const server = http.createServer();
const controller = new Controller();

server.on("request", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.status = 200;
    res.end();
    return;
  }
  if (req.url === "/") {
    await controller.handleFormData(req, res);
  }
  if (req.url === "/merge") {
    await controller.handleMerge(req, res);
    return;
  }
  if (req.url === "/verify") {
    await controller.handleVerifyUpload(req, res);
    return;
  }
});

server.listen(3000, () => console.log("监听3000端口中"));
