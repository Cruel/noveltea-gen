/**
 * Reviewed C01 source-exit baseline; the normative interpretation remains
 * docs/generation-recovery-contract.md. Each token in reviewedReturns is
 * <16-hex AST fingerprint>:<disposition>, in ordinal order (owner/return#N).
 * reviewedThrows lists individual throw fingerprints (owner/throw#N); each is
 * X, an exception requiring boundary classification, not permission to replay.
 *
 * G = graph progress, R = original recovery assessment, O = unresolved work
 * recorded for later reconciliation, F = direct blocked/integrity stop (gap),
 * U = author/resource stop, B = blocked-or-paused stop depending on proof,
 * S = conditional stop/control result, V = completion verdict gate.
 *
 * An edit to an existing return/throw must change its fingerprint, and an
 * added/removed exit changes the ID sequence. Review that exact source exit,
 * its effect proof and intended C02-C08 disposition before updating this file.
 */
export const reviewedReturnExits = {
  schedule:
    "7ba988f923242008:G a4f7e34d46ebda6a:S 9c6097574d6b21f2:G e50b0d991517867a:G 0b1db0f8f7a7f522:B 8cb57d4b39c3c509:B 47d8e66b093d9b20:G 6f5dbcb7f0039928:R d7c8939bedacfd7d:B",
  assess_recovery:
    "42d07008d2732334:F 0ba054199a4fae36:B c672741a55275f3c:U 37ac0fcf81593fde:U a82ee6005950dfd8:F 1b1e92b10da0f4a4:F 847377c251391777:F 4b1fc97521b4c16b:S bb65f63e263b2fe8:F 0d98a4d66450cb87:G 128687fb2b296bcd:F 0d98a4d66450cb87:G c6a6c70112e77cf8:F 27fe5712f50f7abb:F 0a1d512a1ea80f42:F 709ddcba4378d1e8:G 709ddcba4378d1e8:G 170918fa99798bda:F 5d2896d748d553b3:B 591823c6f3985766:G",
  author_update_intake:
    "eafd412bec4b2843:G cfba761fff836f54:S e4b08665b2511bc8:G 5d687f16a5596c4f:R e4b08665b2511bc8:G e4b08665b2511bc8:G fdbf39f3b7061801:R a260befd39f85294:S aecf7db872f4fc88:G 73bc16b555ae8f07:G f49f72da98546066:R 4d083c13dcc1e236:G 42867d567e1d95c1:G fceab62ae26516ee:R 5567ab42da73df08:U 51f0c83f7f252518:F 63a353783d128fb6:R e4840f27212ca310:R 3ea9cb6dd42763ac:G fe3e9d5287d5503f:R",
  idea_integration:
    "e4b08665b2511bc8:G 20f588fb0567918e:G 525b4f362005f993:G 525b4f362005f993:G 6d21786f048a0f8f:R",
  verify_idea_integration:
    "fc4216fab4e774f4:G a8f06f34fb2636b9:R 3455306dafdc433b:G c373186eff1403b1:G 85e672986fb4d591:R",
  specialist_dispatch:
    "e4b08665b2511bc8:G 0d9e6ec6e5934712:G 9f8b26ae0a357a24:O ed19971c96f82f6c:R 16827c77cbe7351c:R 0d9e6ec6e5934712:G 179232cd4e6294bf:S 37dc2f379c0b56cc:G 9c449fd8d8e255f9:G 68f520279c4733e1:G 5f21d1ea20af1f8d:R 0e3fde7b04b5c6fb:O 5f21d1ea20af1f8d:R",
  dependency_amendment: "cfba761fff836f54:S 0a126b3a9f0f9f2b:G 179232cd4e6294bf:S 0769876482d9a3e7:R",
  independent_assignment_review: "9c7ec85aecee7718:S",
  verify_committed_work:
    "b1efe5427822edd2:G 46be02fd000dbeda:R 54958ad74d3d985c:G a93c92edb8171d44:G 179232cd4e6294bf:S a426d6990d0699f1:R",
  completion_decision:
    "5385d07936bbd87c:G e82ddace3d270648:S eb5fa434a0efca05:G cfba761fff836f54:S c1f5e16016e58ad7:R 74dad1e1bf39f6fd:F a2d2475ad5855eb0:G 57ac6aa2cc516c6b:G 678d9eac34f185a1:V 179232cd4e6294bf:S a6065c07bce79074:R",
  reconcile:
    "5c2dc0f716c2e00c:U 10e0fa08a73f0cd1:G 762eb69f256bc89b:G 20b3e7613a8cf602:G 7fe0c8e63b1d8e9c:G dcaa1003311bc401:G 12d1365c8abe492a:F a50fde7ff0ca158a:G 7ebc05b087226ab6:F d50ceb7ab7d09978:F 5bb2c217c856ce98:G 25babe207591ae89:R c466c41573ac9b2b:G",
  authorBoundary: "134790b58185ccb6:B f3d245fe979f76f5:R 4ad2292cb6c5c2d3:G 06748905e0dd39db:S",
  independentAssignmentBoundary:
    "e4b08665b2511bc8:G 4ff5ddf9aa4ce6c2:G 533ee3cc0342b623:F fbe7de8cb0b6bb76:G 055a868fb3d29604:G 9c29b16df80db4bc:G ad04cd9e6f4a2e84:U c1e2b51230f953d6:F 1eedebbff7959374:O 96abdde40833c509:G ebbaf6e315bb4cf8:G 7f712b647c7a1bb8:S 055a868fb3d29604:G 7165a972ba3f6817:G 8eb7bb64a16007bd:U c5718e40eb1f47d6:F 1be1fd40a621cde7:F 5d687f16a5596c4f:R",
  operationFailure: "d7c8939bedacfd7d:B 6f8e137a514dd144:F d44d809a12edfc48:R",
  blocked: "b3b5e10959cccbdb:B",
  runStoryGeneration:
    "920e9dd1538fad82:G 4ad2292cb6c5c2d3:G 15c87780c3d70498:R d7c8939bedacfd7d:B b00891ce57d109ec:V",
  observeNodeOutcome: "cafa5b26a70d2f15:S 457eb16703d85c3e:R 791c12224fd3d55c:F",
  recoveryNode:
    "951535636dfdc9d9:F 1b2bfd3978e6627c:F d62792531537fa8b:F a510809dc74cc215:F 0edadc4c8151f4c0:F 533e9704b50c7d64:G 45f4af1e86ee7162:U 1e00488edc815471:G 7e5396dcc912a986:U b30aaa267d235346:G 4d083c13dcc1e236:G 54818287e8077341:G 48472d6f8dc29579:F 0e0f7e47153d103a:R ae4b8b3ed4e09466:F ac12745831f57568:G e42edb38568b51ce:S 952bd06592f1d376:F 42a0c0736aa55303:V ecfd452d8e6a489a:V",
} as const;

export const reviewedThrowExits = {
  schedule:
    "aea92a900ce47858 411a3eae0cf3264b a8edb9348f27a65a 6f51bea018a720ea a62f2d971677c67d ae62df12f59c4766 da0b0f2a87ae9f16 a487edb9609979d3 ae5af9f3c772e569 5b2b502238c5209e 3bf20806b502b598 96e71052b4de2658",
  assess_recovery:
    "b8e839508eb82e79 5ba3a271c3522ef7 3ccc410ba80486e6 7560a93fe575f141 901af6af846912cc d239f0ce472da0a0 9277af1fe7f253d3 c7940c2a3e5537f5 a11058b81b892f89 49e50ec066f8490d",
  author_update_intake: "0abd139e9b6f45a4",
  idea_integration: "5c212deb6b599f1b 2e0ec52402b79d11 8e87eec152864718 c98f90ca62ed64ed c7c8d830407dd1e5",
  verify_idea_integration: "308c430973f6b74e 43e1138180314eb1 a4b0709f69a7c2f3 63cc21025b2defc5",
  specialist_dispatch: "b306d96cffbf864c 95fa1456013e2d48 a1beda487210eb50",
  dependency_amendment: "31c32f029ac15a97 4b99521c61fca4d0",
  independent_assignment_review: "",
  verify_committed_work: "a5bc7d1ba7fb26d5 c949fc12ca8f8afe 90d19dd8ecfbcd01",
  completion_decision: "a71c76f34850a2b8 07a14758d9e6bb2b",
  reconcile:
    "ade1624015af836b e5408683d3fb1dd8 576cff1c194705a5 38db02fe8a6067ea 910345f2baa6e195 c592b6404d524e14 c2b63cf0a6d3c52b ae7ecf07a7181d6c 0d380425d6ace20e",
  authorBoundary: "",
  independentAssignmentBoundary:
    "c8cd7cc55c502826 521ef08533941ab1 e43799344fba1777 9fc14ab700558944 8a9b1302e0f92e00 f1cd3392368b9b1c 9dec175d5a9da64f e74d51185e69d5c5 93a0c3e01a32ed05",
  operationFailure: "",
  blocked: "",
  runStoryGeneration:
    "360d5873992ab308 1f073098fec5b883 81328ed5be7b3037 92a11bc28aa574d0 6d650ac07ddbbb11 1ef54c75bb3f63d1 1584a040886ce2c1 0d6a3899cce3ad54 8c468a57ba68bc74 864da9fe60badee0 8fbc3551aaf81e59 362c25579a3d70fb ec97d854a242f0ab a0aa48577281543a",
  observeNodeOutcome: "8c468a57ba68bc74",
  recoveryNode: "95161aa63e35fdb3 9bade762daaba516 b3c0274d7dab621b 73867eb451597de4",
} as const;

/** Status-property exits also cover concise-arrow helpers (such as the
 * assessor's fence helper), which contain no explicit return statement. */
export const reviewedStatusExits = {
  schedule:
    "f309314d6c8adbdd:G f309314d6c8adbdd:G f309314d6c8adbdd:G e0394fa2f3847b80:F f309314d6c8adbdd:G f309314d6c8adbdd:G",
  assess_recovery:
    "e0394fa2f3847b80:F 28b465f0a9b56ebd:U 64104e1034916182:U e0394fa2f3847b80:F 2b78ad3f49b1ead6:F 088baada343b4451:S f309314d6c8adbdd:G f309314d6c8adbdd:G",
  author_update_intake: "f309314d6c8adbdd:G 64104e1034916182:U e0394fa2f3847b80:F",
  idea_integration: "b2a1ee45d94f53be:G",
  verify_idea_integration: "1ef03b815a1070ca:G",
  specialist_dispatch: "fb8dc871bfe4bc06:G",
  dependency_amendment: "",
  independent_assignment_review: "",
  verify_committed_work: "7eabfb98aa4c295e:G 64104e1034916182:U f309314d6c8adbdd:G 64104e1034916182:U",
  completion_decision:
    "e0394fa2f3847b80:F f309314d6c8adbdd:G e0394fa2f3847b80:F f309314d6c8adbdd:G 650759c538e40764:V",
  reconcile:
    "0937e2eb0b6e647d:U 418047bd610d6bd7:G 418047bd610d6bd7:G 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F",
  authorBoundary: "02da4da9c1ae1e2e:S",
  independentAssignmentBoundary:
    "2b78ad3f49b1ead6:F 0937e2eb0b6e647d:U 2b78ad3f49b1ead6:F 55e387190d8251b9:S 0583d984079e8df6:S 0937e2eb0b6e647d:U 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F",
  operationFailure: "2b78ad3f49b1ead6:F",
  blocked: "097627765dc0b25c:B",
  runStoryGeneration:
    "4b91bbe4dcd1d136:G 28b465f0a9b56ebd:U 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F aa0aa6c25fa8d276:S",
  observeNodeOutcome: "4409d48b659f1cfc:S 4b91bbe4dcd1d136:G",
  recoveryNode: "2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F 2b78ad3f49b1ead6:F 4b91bbe4dcd1d136:G b3c3a129ee36d4e4:U 4b91bbe4dcd1d136:G 088baada343b4451:U 4b91bbe4dcd1d136:G 2b78ad3f49b1ead6:F 4b91bbe4dcd1d136:G 2b78ad3f49b1ead6:F 4b91bbe4dcd1d136:G 2b78ad3f49b1ead6:F",
} as const;

export const reviewedSharedRouteHelper = "60b40846ce5140327811c382ee2200cbe42dab869e5d0104ab2b7fc6b42cb9ea";
