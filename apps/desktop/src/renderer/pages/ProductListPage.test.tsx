import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductListPage } from "./ProductListPage";
import { NotificationsProvider } from "../state/NotificationsContext";

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

describe("ProductListPage — NORMAL/B-TYPE selling type rows", () => {
  const sk6Product = {
    id: "prod-sk6", article: "SK6", color: "Blue", size: "7/10",
    description: null, costPrice: 300, sellingPrice: 550,
    mainGroupId: null, groupId: "group-1", groupName: "EVR GENTS",
    status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01",
  };

  function baseApi() {
    return {
      listMainGroups: vi.fn().mockResolvedValue([]),
      listProductGroups: vi.fn().mockResolvedValue([]),
      listProducts: vi.fn().mockResolvedValue({ rows: [sk6Product], total: 1, page: 1, pageSize: 1000 }),
    };
  }

  it("derives a NORMAL and a B-TYPE display row from the same ArticleSize, ALL shows both", async () => {
    setupDesktop(baseApi());
    render(
      <NotificationsProvider>
        <ProductListPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    await waitFor(() => expect(screen.getByText("SK6 7/10 EVR GENTS")).toBeInTheDocument());
    expect(screen.getByText("SK6 7/10 EVR GENTS - B")).toBeInTheDocument();
    expect(screen.getByText("PKR 550.00")).toBeInTheDocument();
    expect(screen.getByText("PKR 380.00")).toBeInTheDocument(); // 550 in 501-599 bracket -> -170
    expect(screen.getByText("2 products")).toBeInTheDocument();
  });

  it("Type filter shows only NORMAL, only B-TYPE, or ALL — never duplicates the underlying product", async () => {
    setupDesktop(baseApi());
    render(
      <NotificationsProvider>
        <ProductListPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    await waitFor(() => expect(screen.getByText("SK6 7/10 EVR GENTS")).toBeInTheDocument());
    const typeFilter = screen.getByRole("combobox", { name: /selling type/i });

    await userEvent.selectOptions(typeFilter, "NORMAL");
    expect(screen.getByText("SK6 7/10 EVR GENTS")).toBeInTheDocument();
    expect(screen.queryByText("SK6 7/10 EVR GENTS - B")).not.toBeInTheDocument();
    expect(screen.getByText("1 products")).toBeInTheDocument();

    await userEvent.selectOptions(typeFilter, "B_TYPE");
    expect(screen.queryByText("SK6 7/10 EVR GENTS")).not.toBeInTheDocument();
    expect(screen.getByText("SK6 7/10 EVR GENTS - B")).toBeInTheDocument();
    expect(screen.getByText("1 products")).toBeInTheDocument();

    await userEvent.selectOptions(typeFilter, "ALL");
    expect(screen.getByText("SK6 7/10 EVR GENTS")).toBeInTheDocument();
    expect(screen.getByText("SK6 7/10 EVR GENTS - B")).toBeInTheDocument();
    expect(screen.getByText("2 products")).toBeInTheDocument();
  });

  it("does not show a B-TYPE row when NORMAL price is missing/invalid — never invents a price", async () => {
    const noPriceProduct = { ...sk6Product, id: "prod-nop", sellingPrice: null };
    setupDesktop({
      listMainGroups: vi.fn().mockResolvedValue([]),
      listProductGroups: vi.fn().mockResolvedValue([]),
      listProducts: vi.fn().mockResolvedValue({ rows: [noPriceProduct], total: 1, page: 1, pageSize: 1000 }),
    });
    render(
      <NotificationsProvider>
        <ProductListPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    await waitFor(() => expect(screen.getByText("SK6 7/10 EVR GENTS")).toBeInTheDocument());
    expect(screen.queryByText("SK6 7/10 EVR GENTS - B")).not.toBeInTheDocument();
    expect(screen.getByText("1 products")).toBeInTheDocument();
  });
});
