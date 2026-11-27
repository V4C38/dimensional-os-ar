"""Bake link-local OpenYAM visuals for WebXR and native Lens MeshBuilder."""
import argparse
import json
import math
from pathlib import Path
import struct
import xml.etree.ElementTree as ET


def bake_openyam(root: Path, glb: Path) -> None:
    """Regenerate the canonical GLB and test pose with the installed dimOS model."""
    import numpy as np
    from scipy.spatial.transform import Rotation
    import trimesh
    from dimos.ar.manipulation.model import describe_model
    from dimos.robot.manipulators.openyam.config import make_openyam_model_config

    config = make_openyam_model_config(robot="arm")
    loaded = config.model.load()
    descriptor = describe_model(
        loaded.xml, "/models/openyam.glb", visual_profile="openyam",
        gripper_joint_names=["arm/joint7"],
    )
    scene = trimesh.Scene()
    for link in ET.fromstring(loaded.xml).findall("link"):
        visuals = []
        for visual in link.findall("visual"):
            mesh = visual.find("geometry/mesh")
            if mesh is None:
                raise ValueError(f"Expected visual mesh for {link.attrib['name']}")
            geometry = trimesh.load_mesh(mesh.attrib["filename"])
            geometry.apply_scale([float(v) for v in mesh.get("scale", "1 1 1").split()])
            origin = visual.find("origin")
            if origin is not None:
                transform = np.eye(4)
                transform[:3, :3] = Rotation.from_euler(
                    "xyz", [float(v) for v in origin.get("rpy", "0 0 0").split()]
                ).as_matrix()
                transform[:3, 3] = [float(v) for v in origin.get("xyz", "0 0 0").split()]
                geometry.apply_transform(transform)
            visuals.append(geometry)
        if visuals:
            name = link.attrib["name"]
            scene.add_geometry(trimesh.util.concatenate(visuals).convex_hull,
                               node_name=name, geom_name=name)
    scene.metadata["visual_signature"] = descriptor["visual_signature"]
    glb.write_bytes(trimesh.exchange.gltf.export_glb(scene))

    # The integration peers display the measured tip at the canonical home pose.
    joints = dict(zip(config.joint_names, config.home_joints, strict=True))
    import pinocchio as pin
    model = pin.buildModelFromXML(loaded.xml)
    coordinates = pin.neutral(model)
    for name, value in joints.items():
        coordinates[model.joints[model.getJointId(name)].idx_q] = value
    data = model.createData()
    pin.framesForwardKinematics(model, data, coordinates)
    tip = data.oMf[model.getFrameId(config.planning_groups[0].tip_link)]
    fixture = {"model": descriptor, "joints": joints, "pose": {
        "position": tip.translation.tolist(),
        "orientation": Rotation.from_matrix(tip.rotation).as_quat().tolist(),
    }}
    (root / "clients/webxr/tests/integration-tests/fixtures/OpenYAM.json").write_text(
        json.dumps(fixture, indent=2) + "\n")
    (root / "clients/core/tests/support/IntegrationArmFixture.ts").write_text(
        "export const ARM_FIXTURE = " + json.dumps(fixture, separators=(",", ":")) + ";\n")


def export(source: Path) -> dict:
    data = source.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + size])
    binary = data[28 + size:]
    def accessor(index: int) -> list:
        item = document["accessors"][index]
        view = document["bufferViews"][item["bufferView"]]
        width = {"SCALAR": 1, "VEC3": 3}[item["type"]]
        code = {5123: "H", 5125: "I", 5126: "f"}[item["componentType"]]
        offset = view.get("byteOffset", 0) + item.get("byteOffset", 0)
        stride = view.get("byteStride", struct.calcsize(code) * width)
        return [value for row in range(item["count"])
                for value in struct.unpack_from("<" + code * width, binary, offset + row * stride)]
    links = {}
    for node in document["nodes"]:
        if "mesh" not in node:
            continue
        mesh = document["meshes"][node["mesh"]]
        if len(mesh["primitives"]) != 1:
            raise ValueError("Expected one triangle primitive per link")
        primitive = mesh["primitives"][0]
        if primitive.get("mode", 4) != 4 or any(key in node for key in ("matrix", "translation", "rotation", "scale")):
            raise ValueError("Expected link-local triangle geometry")
        positions = [round(v, 8) for v in accessor(primitive["attributes"]["POSITION"])]
        indices = accessor(primitive["indices"])
        normals = [0.0] * len(positions)
        for offset in range(0, len(indices), 3):
            a, b, c = [indices[offset + j] * 3 for j in range(3)]
            u = [positions[b + j] - positions[a + j] for j in range(3)]
            v = [positions[c + j] - positions[a + j] for j in range(3)]
            normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
            for vertex in (a, b, c):
                for j in range(3):
                    normals[vertex + j] += normal[j]
        for offset in range(0, len(normals), 3):
            length = math.hypot(*normals[offset:offset + 3])
            if length:
                normals[offset:offset + 3] = [round(value / length, 8) for value in normals[offset:offset + 3]]
        links[node["name"]] = {"positions": positions, "indices": indices, "normals": normals}
    return {"signature": document["scenes"][0]["extras"]["visual_signature"], "links": links}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-dimos", action="store_true",
                        help="also regenerate the WebXR GLB and fixture from installed dimOS")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    glb = root / "clients/webxr/public/models/openyam.glb"
    if args.from_dimos:
        bake_openyam(root, glb)
    result = export(glb)
    output = root / "clients/specs/Assets/Scripts/DimOSSpecsClient/manipulation/OpenYAMMesh.ts"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('// OpenYAM geometry from dimOS dim_description (openyam_single); see clients/webxr/public/models/NOTICE.md.\n'
                      '// Generated by clients/specs/tools/export_manipulation_mesh.py.\n'
                      'export const OPENYAM_MESH: { signature: string; links: Record<string, { positions: number[]; indices: number[]; normals: number[] }> } = '
                      + json.dumps(result, separators=(",", ":")) + ';\n')
