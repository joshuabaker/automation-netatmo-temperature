import { Hono } from "hono";
import check from "./check.js";
import reset from "./reset.js";

const app = new Hono();

app.route("/check", check);
app.route("/reset", reset);

export default app;
