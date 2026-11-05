#define TEST_ICON 'icons/test.dmi'
#define TEST_TINT "#ffcc88"
/obj/item
	icon = TEST_ICON
	color = TEST_TINT
/obj/item/tool
	name = "tool"
	icon_state = "tool"
/obj/item/alias
	parent_type = /obj/item/tool
/*
/obj/item/tool
	name = "must not override"
*/
GLOBAL_LIST_INIT(test_child_pool, list(/obj/item/tool = 2))
GLOBAL_LIST_INIT(test_parent_pool, list(GLOB.test_child_pool = 5, /obj/item/alias = 1))
/turf/closed/mineral
	icon = MAP_SWITCH('icons/runtime-rock.dmi', 'icons/editor-rock.dmi')
	transform = MAP_SWITCH(TRANSLATE_MATRIX(-8, -8), matrix())
