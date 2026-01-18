import { Hono } from "hono";
import check from "./api/check";
import reset from "./api/reset";

const app = new Hono();

app.route("/check", check);
app.route("/reset", reset);

export default app;
