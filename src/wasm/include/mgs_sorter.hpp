/* mgs_sorter.hpp
 *
 * contains the definition for the sorting implementation
 */

#ifndef MGS_SORTER_HPP
#define MGS_SORTER_HPP

#include <vector>
#include <memory>
#include <pthread.h>

#include "mgs_gaussians.h"

namespace mgs
{

//-------------------------------------------//

/**
 * performs culling and sorting on gaussians
 */
class Sorter
{
public:
	Sorter(const std::shared_ptr<MGSgaussians>& gaussians);
	~Sorter();

	void sort(const QMmat4& view, const QMmat4& proj, float time, bool isAsync = false);
	
	void sort_async_start(const QMmat4& view, const QMmat4& proj, float time);
	bool sort_async_pending() const;
	bool sort_async_tryjoin();

	const std::vector<uint32_t>& get_latest() const;

private:
	std::shared_ptr<MGSgaussians> m_gaussians;
	std::vector<uint32_t> m_indices;

	struct AsyncThreadData
	{
		bool active = false;
		pthread_t thread;

		QMmat4 view;
		QMmat4 proj;
		float time;

		Sorter* sorter;
	} m_asyncThreadData;

	static void* start_async_thread(void* arg);
};

}; //namespace mgs

#endif //#ifndef MGS_SORTER_HPP
