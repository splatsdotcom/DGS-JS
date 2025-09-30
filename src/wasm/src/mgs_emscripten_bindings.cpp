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

    	.property("length", &mgs::GaussianGroup::get_num_gaussians)

    	.property("shDegree", &mgs::GaussianGroup::get_sh_degree)

		.property("buffer", emscripten::optional_override([](const mgs::GaussianGroup& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.get_num_gaussians() * sizeof(mgs::GaussianPacked), 
				(const uint8_t*)self.get_gaussians().data()
			));
		}));

	emscripten::function("loadPly", emscripten::optional_override([](const emscripten::val& arg)
	{
		emscripten::val bufView = emscripten::val::global("Uint8Array").new_(arg);
		std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bufView);

		return std::make_shared<mgs::GaussianGroup>(mgs::ply::load(data));
	}));
}
