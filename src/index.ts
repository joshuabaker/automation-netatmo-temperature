import { Hono } from "hono";
import check from "./api/check.js";
import reset from "./api/reset.js";

const app = new Hono();

app.route("/", check);
app.route("/", reset);

export default app;
