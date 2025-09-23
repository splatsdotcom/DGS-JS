#include <emscripten/bind.h>
#include <vector>
#include <memory>
#include <iostream>

#include "mgs_gaussian.hpp"
#include "mgs_ply.hpp"

//-------------------------------------------//

EMSCRIPTEN_BINDINGS(libmgs_js)
{
	emscripten::class_<mgs::GaussianGroup>("GaussianGroup")
		.smart_ptr<std::shared_ptr<mgs::GaussianGroup>>("GaussianGroup")

		.function("count", &mgs::GaussianGroup::count)

		.function("sortedIndices", emscripten::optional_override([](mgs::GaussianGroup& self, float camX, float camY, float camZ)
		{
			auto indices = std::make_shared<std::vector<uint32_t>>(self.sorted_indices(vec3(camX, camY, camZ)));
			return indices;
		}))

		.function("sortIndicesAsync", emscripten::optional_override([](mgs::GaussianGroup& self, float camX, float camY, float camZ)
		{
			self.sort_indices_async(vec3(camX, camY, camZ));
		}))

		.function("sortIndicesAsyncRetrieve", emscripten::optional_override([](mgs::GaussianGroup& self) -> std::shared_ptr<std::vector<uint32_t>>
		{
			auto indices = self.sort_indices_async_retrieve();
			if(!indices.has_value())
				return nullptr;

			return std::make_shared<std::vector<uint32_t>>(std::move(indices.value()));
		}))

		.function("getBuffer", emscripten::optional_override([](const mgs::GaussianGroup& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.data().size() * sizeof(mgs::GaussianPacked), 
				(const uint8_t*)self.data().data()
			));
		}));

	emscripten::class_<std::vector<uint32_t>>("GaussianGroupIndices")
		.smart_ptr<std::shared_ptr<std::vector<uint32_t>>>("GaussianGroupIndices")

		.function("getBuffer", emscripten::optional_override([](std::vector<uint32_t>& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.size() * sizeof(uint32_t), 
				(const uint8_t*)self.data()
			));
		}));

	emscripten::function("loadPlyPacked", emscripten::optional_override([](const emscripten::val& arg)
	{
		emscripten::val bufView = emscripten::val::global("Uint8Array").new_(arg);
		std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bufView);

		return std::make_shared<mgs::GaussianGroup>(mgs::ply::load_packed(data));
	}));
}
