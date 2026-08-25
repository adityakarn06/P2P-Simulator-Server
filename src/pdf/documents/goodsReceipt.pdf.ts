import {
  drawDocumentHeader,
  drawFooter,
  drawKeyValueBlock,
  drawLineItemTable,
  formatQuantity,
} from "../layout.js";
import { createDocument, renderToBuffer } from "../render.js";

export interface GoodsReceiptPdfInput {
  organizationName: string;
  goodsReceiptId: string;
  poNumber: string;
  trackingNumber: string;
  status: string;
  receivedAt: Date;
  receivedBy: string | null;
  notes: string | null;
  items: {
    description: string;
    orderedQuantity: number;
    receivedQuantity: number;
    damagedQuantity: number;
    acceptedQuantity: number;
  }[];
}

export async function renderGoodsReceiptPdf(input: GoodsReceiptPdfInput): Promise<Buffer> {
  const doc = createDocument();
  const promise = renderToBuffer(doc);

  drawDocumentHeader(doc, {
    organizationName: input.organizationName,
    title: "Goods Receipt",
    documentNumber: input.goodsReceiptId,
    date: input.receivedAt,
  });

  drawKeyValueBlock(doc, "Receipt details", [
    ["Purchase order", input.poNumber],
    ["Shipment tracking number", input.trackingNumber],
    ["Status", input.status],
    ["Received by", input.receivedBy ?? "—"],
    ...(input.notes ? ([["Notes", input.notes]] as [string, string][]) : []),
  ]);

  drawLineItemTable(
    doc,
    [
      { label: "Description", width: 160 },
      { label: "Ordered", width: 80, align: "right" },
      { label: "Received", width: 80, align: "right" },
      { label: "Damaged", width: 80, align: "right" },
      { label: "Accepted", width: 80, align: "right" },
    ],
    input.items.map((item) => [
      item.description,
      formatQuantity(item.orderedQuantity),
      formatQuantity(item.receivedQuantity),
      formatQuantity(item.damagedQuantity),
      formatQuantity(item.acceptedQuantity),
    ]),
  );

  drawFooter(
    doc,
    "This goods receipt was recorded by a simulated IoT delivery event and is not a legally binding document.",
  );

  doc.end();
  return promise;
}
