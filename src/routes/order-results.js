import express from "express";
import { getReviewOrder } from "../order-store.js";

export function createOrderResultsRouter() {
  const router = express.Router();

  router.get("/api/x402/orders/:orderId", async (req, res, next) => {
    try {
      const order = await authenticatedOrder(req);
      if (!order) return res.status(404).json({ error: "order not found" });
      return res.json(publicOrderStatus(order));
    } catch (error) {
      return next(error);
    }
  });

  router.get("/api/x402/orders/:orderId/result", async (req, res, next) => {
    try {
      const order = await authenticatedOrder(req);
      if (!order) return res.status(404).json({ error: "order not found" });
      if (!order.result) {
        return res.status(202).json({
          order_id: order.orderId,
          status: order.review.status,
          message: "Review is not complete yet.",
        });
      }
      return res.status(order.review.status === "completed" || order.review.status === "needs_input" ? 200 : 202)
        .json(order.result.json);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/api/x402/orders/:orderId/report.md", async (req, res, next) => {
    try {
      const order = await authenticatedOrder(req);
      if (!order) return res.status(404).json({ error: "order not found" });
      if (!order.result) {
        return res.status(202).json({
          order_id: order.orderId,
          status: order.review.status,
          message: "Review is not complete yet.",
        });
      }
      res.type("text/markdown");
      return res.status(order.review.status === "completed" || order.review.status === "needs_input" ? 200 : 202)
        .send(order.result.markdown);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

async function authenticatedOrder(req) {
  const authorization = String(req.get("authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1].trim() || req.query.access_token) return null;
  return getReviewOrder(req.params.orderId, match[1].trim());
}

function publicOrderStatus(order) {
  return {
    order_id: order.orderId,
    service: order.service,
    payment: order.payment,
    request: {
      repository_or_url: order.request.repository_or_url,
      goal: order.request.goal,
      response_format: order.request.response_format,
      language: order.request.language,
    },
    review: {
      ...order.review,
      result_available: Boolean(order.result),
      result_url: `/api/x402/orders/${encodeURIComponent(order.orderId)}/result`,
      report_url: `/api/x402/orders/${encodeURIComponent(order.orderId)}/report.md`,
    },
    result: order.result
      ? {
          schema_version: order.result.schemaVersion,
          verdict: order.result.verdict,
          score: order.result.score,
          created_at: order.result.createdAt,
        }
      : null,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}
