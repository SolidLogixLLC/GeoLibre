import {
  act,
  fireEvent,
  render,
  screen,
  useAppStore,
  useDesktopSettingsStore,
  within,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { geojsonLayer } from "./helpers/layer-fixtures";

/**
 * "Compact layer cards" defaults to on in this fork. Tests below that exercise
 * the pre-compact row (its buttons are direct children rather than behind an
 * expand chevron) turn it off explicitly; the compact layout gets its own
 * describe block further down.
 */
function setCompactLayerCards(value: boolean): void {
  useDesktopSettingsStore.setState((state) => ({
    desktopSettings: {
      ...state.desktopSettings,
      layout: { ...state.desktopSettings.layout, compactLayerCards: value },
    },
  }));
}

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { LayerPanel } = await import("../apps/geolibre-desktop/src/components/panels/LayerPanel");

const noop = () => {};

/** Render the Layers panel with no map behind it (`mapControllerRef` is null). */
function renderLayerPanel() {
  return render(
    createElement(LayerPanel, {
      themeMode: "light",
      mapControllerRef: { current: null },
      onResizeStart: noop,
      geometryEditLayerId: null,
      onToggleGeometryEdit: noop,
      onCancelGeometryEdit: noop,
      onMaterializeDuckDBLayer: noop,
      onOpenRasterStylePanel: noop,
      onOpenRasterSubset: noop,
    }),
  );
}

/** The rendered layer rows, top to bottom, as their displayed names. */
function rowNames(): string[] {
  return screen
    .queryAllByTestId("layer-row")
    .map((row) => row.getAttribute("data-layer-name") ?? "");
}

/** The row element for the layer shown as `name`. */
function row(name: string): HTMLElement {
  const match = screen.getAllByTestId("layer-row").find((el) => el.dataset.layerName === name);
  assert.ok(match, `no layer row named ${name}`);
  return match;
}

function layer(id: string) {
  return useAppStore.getState().layers.find((entry) => entry.id === id);
}

describe("LayerPanel", () => {
  it("lists the store's layers with the topmost map layer first", () => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();

    // The store keeps draw order (last = top), the panel shows top first.
    assert.deepEqual(rowNames(), ["Parks", "Rivers"]);
  });

  it("follows the store when a layer is added after the first render", () => {
    renderLayerPanel();
    assert.deepEqual(rowNames(), []);

    // A store write from outside React (a map event, a plugin) goes through
    // `act` so React flushes the re-render before the assertion.
    act(() => {
      useAppStore.setState({ layers: [geojsonLayer({ id: "roads", name: "Roads" })] });
    });

    assert.deepEqual(rowNames(), ["Roads"]);
  });

  it("toggles a layer's visibility in the store from its eye button", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.click(within(row("Parks")).getByRole("button", { name: "Hide layer" }));
    assert.equal(layer("parks")?.visible, false);

    // The button flips to the opposite action once the layer is hidden.
    fireEvent.click(within(row("Parks")).getByRole("button", { name: "Show layer" }));
    assert.equal(layer("parks")?.visible, true);
  });

  it("renames a layer on double-click and Enter", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.doubleClick(within(row("Parks")).getByText("Parks"));
    const input = screen.getByRole("textbox", { name: "Rename Parks" });
    fireEvent.change(input, { target: { value: "  City parks  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    assert.equal(layer("parks")?.name, "City parks");
    assert.deepEqual(rowNames(), ["City parks"]);
    assert.equal(screen.queryAllByRole("textbox", { name: /^Rename / }).length, 0);
  });

  it("keeps the old name when a rename is cancelled with Escape", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.doubleClick(within(row("Parks")).getByText("Parks"));
    const input = screen.getByRole("textbox", { name: "Rename Parks" });
    fireEvent.change(input, { target: { value: "Something else" } });
    fireEvent.keyDown(input, { key: "Escape" });

    assert.equal(layer("parks")?.name, "Parks");
    assert.deepEqual(rowNames(), ["Parks"]);
  });

  it("ignores a rename to a blank name", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.doubleClick(within(row("Parks")).getByText("Parks"));
    const input = screen.getByRole("textbox", { name: "Rename Parks" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    assert.equal(layer("parks")?.name, "Parks");
  });

  it("selects a layer in the store when its row is clicked", () => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();

    fireEvent.click(row("Rivers"));

    assert.equal(useAppStore.getState().selectedLayerId, "rivers");
    assert.equal(row("Rivers").getAttribute("aria-pressed"), "true");
    assert.equal(row("Parks").getAttribute("aria-pressed"), "false");
  });

  it("moves a layer up the draw order", () => {
    setCompactLayerCards(false);
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();

    fireEvent.click(within(row("Rivers")).getByRole("button", { name: "Move up" }));

    assert.deepEqual(
      useAppStore.getState().layers.map((entry) => entry.id),
      ["parks", "rivers"],
    );
    assert.deepEqual(rowNames(), ["Rivers", "Parks"]);
  });

  it("keeps the metadata dialog in step with the live layer", () => {
    setCompactLayerCards(false);
    useAppStore.setState({
      layers: [geojsonLayer({ id: "parks", name: "Parks", metadata: { featureCount: 3 } })],
    });
    renderLayerPanel();

    fireEvent.click(within(row("Parks")).getByRole("button", { name: "Metadata" }));
    let dialog = screen.getByRole("dialog");
    within(dialog).getByText("Parks Metadata");

    // A rename and a metadata change made while the dialog is open (the row's
    // rename, a refresh) show up in it rather than the snapshot taken on open.
    act(() => {
      useAppStore.getState().updateLayer("parks", {
        name: "City parks",
        metadata: { featureCount: 5 },
      });
    });
    dialog = screen.getByRole("dialog");
    within(dialog).getByText("City parks Metadata");
    const json = JSON.parse(dialog.querySelector("pre")?.textContent ?? "{}");
    assert.equal(json.layerName, "City parks");
    assert.equal(json.featureCount, 5);

    // Removing the layer closes the dialog instead of leaving it on a ghost.
    act(() => {
      useAppStore.getState().removeLayer("parks");
    });
    assert.equal(screen.queryAllByRole("dialog").length, 0);

    // The id was dropped too: a new layer that reuses it does not reopen it.
    act(() => {
      useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks again" })] });
    });
    assert.equal(screen.queryAllByRole("dialog").length, 0);
  });

  it("keeps today's row layout unchanged when Compact layer cards is off", () => {
    setCompactLayerCards(false);
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    const parksRow = row("Parks");
    assert.equal(parksRow.hasAttribute("data-compact"), false);
    // The opacity slider and the full action row are direct children of the
    // card — no expand/collapse control to get past.
    assert.ok(within(parksRow).queryByTitle("Double-click to enter an exact value"));
    within(parksRow).getByRole("button", { name: "Move up" });
    within(parksRow).getByRole("button", { name: "Metadata" });
    within(parksRow).getByRole("button", { name: "Remove layer" });
    assert.equal(
      within(parksRow).queryAllByRole("button", { name: /^Expand / }).length,
      0,
    );
  });
});

describe("LayerPanel compact layer cards", () => {
  it("collapses a layer card to one row by default", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    const parksRow = row("Parks");
    assert.ok(parksRow.hasAttribute("data-compact"));
    // The eye toggle, name and "..." menu stay visible collapsed; the
    // opacity slider and the compact action bar do not until expanded.
    within(parksRow).getByRole("button", { name: "Hide layer" });
    within(parksRow).getByRole("button", { name: "Layer actions" });
    const chevron = within(parksRow).getByRole("button", { name: "Expand Parks" });
    assert.equal(chevron.getAttribute("aria-expanded"), "false");
    assert.equal(
      within(parksRow).queryByTitle("Double-click to enter an exact value"),
      null,
    );
    assert.equal(within(parksRow).queryAllByRole("button", { name: "Zoom to" }).length, 0);
    assert.equal(within(parksRow).queryAllByRole("button", { name: "Metadata" }).length, 0);
  });

  it("expands a card on chevron click to reveal opacity and actions, and keeps focus on the chevron", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    const parksRow = row("Parks");
    const expandButton = within(parksRow).getByRole("button", { name: "Expand Parks" });
    expandButton.focus();
    fireEvent.click(expandButton);

    const collapseButton = within(parksRow).getByRole("button", { name: "Collapse Parks" });
    assert.equal(collapseButton.getAttribute("aria-expanded"), "true");
    // The control the user just activated is the one focus stays on, so a
    // keyboard user's place in the list is never lost across the toggle.
    assert.equal(document.activeElement, collapseButton);
    within(parksRow).getByTitle("Double-click to enter an exact value");
    within(parksRow).getByRole("button", { name: "Zoom to" });
    within(parksRow).getByRole("button", { name: "Identify" });
    within(parksRow).getByRole("button", { name: "Metadata" });
    // Move up/down and Remove moved out of the row into the "..." menu.
    assert.equal(within(parksRow).queryAllByRole("button", { name: "Move up" }).length, 0);
    assert.equal(within(parksRow).queryAllByRole("button", { name: "Remove layer" }).length, 0);

    fireEvent.click(collapseButton);
    const expandAgain = within(row("Parks")).getByRole("button", { name: "Expand Parks" });
    assert.equal(expandAgain.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, expandAgain);
    assert.equal(
      within(row("Parks")).queryByTitle("Double-click to enter an exact value"),
      null,
    );
  });

  it("still toggles visibility and renames from the collapsed row", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.click(within(row("Parks")).getByRole("button", { name: "Hide layer" }));
    assert.equal(layer("parks")?.visible, false);

    fireEvent.doubleClick(within(row("Parks")).getByText("Parks"));
    const input = screen.getByRole("textbox", { name: "Rename Parks" });
    fireEvent.change(input, { target: { value: "City parks" } });
    fireEvent.keyDown(input, { key: "Enter" });
    assert.equal(layer("parks")?.name, "City parks");
  });

  it("shows a member-layer count on a group header instead of always-on opacity", () => {
    act(() => {
      useAppStore.getState().addLayerGroup("Faults", []);
    });
    const groupId = useAppStore.getState().layerGroups[0]?.id;
    assert.ok(groupId);
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "qfaults", name: "USGS QFaults", groupId }),
        geojsonLayer({ id: "gem", name: "GEM Global Active Faults", groupId }),
      ],
    });
    renderLayerPanel();

    const header = screen.getByTestId("layer-group-header");
    within(header).getByText("2");
    // The slider is not always shown under a compact group header anymore.
    assert.equal(
      within(header).queryByTitle("Double-click to enter an exact value"),
      null,
    );
  });
});
