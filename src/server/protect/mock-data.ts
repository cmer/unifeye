/** Simulated inventory for mock mode and automated tests. `indoors` + `upper_level` matches exactly four. */
/** `mic: false` cameras send no audio, like a Protect camera without a microphone. */
export interface MockCamera { protectId: string; name: string; online: boolean; hue: number; tags: string[]; mic: boolean }
const C = (n: number, name: string, hue: number, tags: string[], online = true, mic = true): MockCamera => ({ protectId: `mock-${String(n).padStart(2, "0")}`, name, online, hue, tags, mic });
/** Cameras that act like ones made by someone else: their video can also be read from the camera itself. */
export const MOCK_DIRECT = new Set(["mock-08", "mock-09", "mock-12"]);
export const MOCK_CAMERAS: MockCamera[] = [
  C(1, "Front Entrance", 215, ["outdoors", "ground_level", "entrance", "public_area"]),
  C(2, "Lobby Front Desk", 30, ["indoors", "ground_level", "front_desk", "public_area"]),
  C(3, "Reception Waiting", 190, ["indoors", "ground_level", "front_desk", "public_area"], true, false),
  C(4, "Upper Hallway East", 220, ["indoors", "upper_level", "hallway"]),
  C(5, "Upper Hallway West", 260, ["indoors", "upper_level", "hallway"]),
  C(6, "Upper Lounge", 20, ["indoors", "upper_level", "public_area"]),
  C(7, "Upper Stairwell", 200, ["indoors", "upper_level", "stairwell"], true, false),
  C(8, "Roof Terrace", 205, ["outdoors", "upper_level"]),
  C(9, "Parking Lot North", 210, ["outdoors", "parking", "perimeter"]),
  C(10, "Parking Lot South", 225, ["outdoors", "parking", "perimeter"], false),
  C(11, "Loading Dock", 35, ["outdoors", "perimeter", "deliveries"]),
  C(12, "Rear Exit", 150, ["outdoors", "perimeter", "entrance"]),
  C(13, "Stock Room", 40, ["indoors", "ground_level", "restricted"]),
  C(14, "Server Closet", 240, ["indoors", "ground_level", "restricted"], true, false),
];
