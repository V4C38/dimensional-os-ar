import { expect, it } from "vitest";
import { decodeNavigationMap, decodeNavigationMapHeader } from "DimOSARClient.lspkg/Scripts/DimOSARClient/websocket/BulkTransfer";
import { IntegrationV2Fixture } from "../integration-tests/IntegrationV2Fixture";

it("delivers a native map fixture through the real bulk decoder", () => {
  const text: string[] = [], packets: Uint8Array[] = [];
  const peer = new IntegrationV2Fixture(() => {}, "fixture-client", () => 0);
  peer.bind({ onTransportOpen() {}, onTransportClose() {}, onTransportText: value => text.push(value),
    onTransportBinary: value => packets.push(value) });
  peer.sendText(JSON.stringify({ type: "bulk_hello_request" }));
  peer.navigationMap({ subscription_id: "map-a", sequence: 3, center: [2, -1] }, "odom-a", [3, 2]);
  const header = decodeNavigationMapHeader(JSON.parse(text.find(value => value.includes("bulk_binary_begin"))!));
  const bytes = new Uint8Array(header.width * header.height + header.height_count * 12 + header.route_count * 16);
  let next = 0;
  for (const packet of packets) {
    const frame = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    expect(frame.getUint32(0, true)).toBe(0x32425241);
    expect(frame.getUint32(8, true)).toBe(next);
    bytes.set(packet.subarray(12), next); next += packet.length - 12;
  }
  const map = decodeNavigationMap(header, bytes);
  expect(map.subscription_id).toBe("map-a"); expect(map.sequence).toBe(3);
  expect(map.odom_reference_id).toBe("odom-a"); expect(map.origin).toEqual([-4, -7]);
  expect(map.cells.costAt(120 * 20)).toBe(40);
  expect(map.heights[0]).toEqual([1, 1, expect.closeTo(0.6)]);
  expect(map.target).toEqual([3, 2]); expect(map.route[0]).toEqual([0, 0, 3, 2]);
});
